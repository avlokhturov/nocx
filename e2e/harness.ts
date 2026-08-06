import { test as base, expect as baseExpect, type Page } from '@playwright/test'

import { BASE_URL } from './base-url'

export { expect } from '@playwright/test'
export type { Page } from '@playwright/test'

/**
 * Wait until the prompt editor owns input and typing can safely begin.
 *
 * Scoped to the ACTIVE pane, not to the document. Every open tab has its own
 * `.nocx-editor-input`, so a bare locator resolves to one element with a single
 * tab and N with more — Playwright's strict mode then fails the wait rather than
 * the assertion, which reads like a product bug and is not one. That is what
 * broke every multi-tab-input case (nocx-4ff.28) when this helper met a suite
 * that opens a second tab.
 *
 * Waiting on the active pane is also the more correct statement: readiness is a
 * property of the tab under test, not of whichever editor the DOM lists first.
 */
export async function promptReady(page: Page): Promise<void> {
  const input = page.locator('.pane.active .nocx-editor-input')
  await baseExpect(input).toBeVisible({ timeout: 10_000 })
  await baseExpect(input).toBeFocused({ timeout: 10_000 })
}

// Shared e2e harness. When the suite runs against the headless
// vite + devharness shim (NOCX_WS_PORT set) instead of `wails dev`, inject the
// Wails GetWSPort binding the frontend expects before any app code runs. Under
// `wails dev` the real binding is present and NOCX_WS_PORT is unset, so this is
// a no-op — the same specs run unchanged in CI.
async function injectWailsShim(page: Page): Promise<void> {
  const port = process.env.NOCX_WS_PORT
  const token = process.env.NOCX_WS_TOKEN
  if (!port) return
  if (!token) {
    throw new Error(
      'NOCX_WS_PORT set but NOCX_WS_TOKEN is missing; ' +
        'the token is the auth gate and an empty string is rejected. ' +
        'Export both or use `wails dev`.',
    )
  }
  await page.addInitScript(
    (opts: { p: string; t: string }) => {
      ;(window as unknown as { go: unknown }).go = {
        main: {
          WailsApp: {
            GetWSPort: () => Promise.resolve(Number(opts.p)),
            GetWSToken: () => Promise.resolve(opts.t),
            CheckForUpdate: () => Promise.resolve(null),
            ReportHealthy: () => Promise.resolve(),
            ApplyUpdate: () => Promise.resolve(),
          },
        },
      }
    },
    { p: port, t: token },
  )
}

export const test = base.extend<object, { appReady: void }>({
  // The app answers on its port before it can serve a session, and the suite
  // used to treat those as the same moment.
  //
  // playwright.config.ts waits for the `wails dev` URL, which the webview
  // serves as soon as vite is up. The BACKEND is not up then: app.New probes
  // the OS keystore synchronously (internal/app/app.go:275), and on a macOS
  // runner with no unlocked login keychain that probe runs to its full timeout
  // — five seconds in CI run 31085068686 — before the WebSocket exists. The
  // renderer cannot open a tab without it.
  //
  // Every spec opens with expect(TAB).toHaveCount(1) on the default 5s
  // expect timeout, so all of them raced that startup and most lost: 33 of 74
  // failed on shard 1, each reporting "resolved to 0 elements" while the
  // error-context snapshot taken moments later showed the tab present. It
  // reads as a broken product and is a harness that started measuring too
  // early.
  //
  // So readiness is waited for ONCE per worker, on its own page, with a budget
  // sized for a cold start rather than for an assertion. Raising every spec's
  // expect timeout would have worked too and would have made every genuine
  // failure in the suite slower to report.
  //
  // The startup stall itself is a product defect and is filed separately: a
  // terminal should not wait on a secret store to show a prompt.
  appReady: [
    async ({ browser }, use) => {
      // newPage() inherits nothing from `use`, so baseURL is passed
      // explicitly — from the module the config reads, not a copy.
      const context = await browser.newContext({ baseURL: BASE_URL })
      const page = await context.newPage()
      try {
        await injectWailsShim(page)
        await page.goto('/')
        await baseExpect(page.locator('.nocx-tab')).toHaveCount(1, { timeout: 90_000 })
      } finally {
        await context.close()
      }
      await use()
    },
    { scope: 'worker', auto: true },
  ],

  page: async ({ page }, use) => {
    await injectWailsShim(page)
    await use(page)
  },
})

// ── Vault e2e helper: managed devharness lifecycle ───────────────────
//
// VaultBackend wraps a devharness child process so a spec can stop and
// restart the backend with a fresh token (which changes per launch). The
// caller provides the binary path; start() returns the WS port and token.
//
// The XDG dirs passed to the constructor are used for every instance, so
// vault state (DB, sealed vault files) survives restart.
//
// Usage:
//   const backend = new VaultBackend('/tmp/nocx-devharness',
//     { data: '/tmp/vt/data', config: '/tmp/vt/config', cache: '/tmp/vt/cache' })
//   const { port, token } = await backend.start(firstPort)
//   // … test …
//   const { port: p2, token: t2 } = await backend.restart(secondPort)

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, openSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'

import { createHomeIsolation, type HomeIsolation } from './home-isolation'

/**
 * A disposable directory the caller owns and cleans up. The backend's whole
 * home is placed inside it, so its settings, profiles, vault documents, shell
 * integration and rc files all land there and nowhere else.
 *
 * This replaced an XDG_CONFIG_HOME/DATA/CACHE trio. Two reasons, and the second
 * is why it was worth the churn: the home covers ~/.nocx, the rc files and
 * ~/.ssh/config, which the trio never did — and the trio is Linux-only, because
 * internal/storage's darwin resolver goes straight to os.UserHomeDir() and
 * never looks at XDG. On a Mac the vault specs believed they were isolated and
 * were writing the developer's real Application Support directory.
 */
export interface DisposableRoot {
  root: string
}

export interface BackendEndpoint {
  port: number
  token: string
}

export class VaultBackend {
  private proc: ChildProcess | null = null
  private logPath = ''

  /** The canonical home this backend was given, once it has been started. */
  private isolation: HomeIsolation | null = null

  constructor(
    private readonly binary: string,
    private readonly disposable: DisposableRoot,
    /**
     * Cut the backend off from the session bus, so its system provider probes
     * as unavailable no matter what is running around the test.
     *
     * A case that needs "no OS keychain" cannot get it by assuming: run the
     * suite inside the dbus-run-session the keyring case requires and the
     * passphrase cases fail, because setup silently succeeds and the dialog
     * they wait for never appears. That is a true result reported as the wrong
     * defect. Pointing DBUS_SESSION_BUS_ADDRESS at nothing makes the condition
     * explicit and identical in both environments.
     */
    private readonly withoutSecretService = false,
  ) {
    if (!existsSync(binary)) {
      throw new Error(`devharness binary not found: ${binary}`)
    }
  }

  /** Start devharness on the given port, wait for WSPORT/WSTOKEN. */
  async start(port: number): Promise<BackendEndpoint> {
    if (this.proc) throw new Error('backend already running; call stop() first')
    this.logPath = resolve(this.disposable.root, `devharness-${port}.log`)
    const logFd = openSync(this.logPath, 'w')

    const overrideEnv: Record<string, string> = { NOCX_WS_ADDR: `127.0.0.1:${port}` }
    if (this.withoutSecretService) {
      overrideEnv.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/nocx-e2e-no-secret-service'
      // The portable half. The line above is a LINUX mechanism: on macOS
      // go-keyring goes to the Security framework and ignores it entirely, so
      // these cases were not arranging "no keystore" there at all — and with a
      // disposable $HOME the framework found no login keychain under it and put
      // a "Keychain not found" dialog on the developer's screen, once per
      // backend start (nocx-o4hg). Both are set: the env var states the premise
      // on every platform, and the dbus one keeps stating it for anything that
      // reads the bus directly.
      overrideEnv.NOCX_NO_SYSTEM_KEYSTORE = '1'
    }

    // The same boundary the default path gets from playwright.config.ts. Built
    // per start() rather than per instance so a restart re-derives it: if the
    // root were ever swapped underneath, the refusals fire again rather than a
    // stale environment being replayed.
    this.isolation = createHomeIsolation({
      inheritedEnv: process.env,
      overrideEnv,
      root: this.disposable.root,
    })
    const env = this.isolation.env as Record<string, string>

    this.proc = spawn(this.binary, [], { env, stdio: ['ignore', logFd, logFd], detached: false })

    // Wait for WSTOKEN line (printed after WSPORT).
    const timeoutMs = 15_000
    const pollIntervalMs = 200
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (!this.proc || (!this.proc.killed && this.proc.exitCode !== null)) {
        const code = this.proc?.exitCode
        const log = readFileSync(this.logPath, 'utf8')
        throw new Error(`devharness exited early (code=${code}):\n${log}`)
      }
      const log = readFileSync(this.logPath, 'utf8')
      const m = log.match(/^WSTOKEN=(.+)$/m)
      if (m) {
        const p = log.match(/^WSPORT=(\d+)$/m)
        return { port: p ? Number(p[1]) : port, token: m[1] }
      }
      const { promise, resolve: later } = Promise.withResolvers<void>()
      setTimeout(later, pollIntervalMs)
      await promise
    }

    throw new Error(`devharness did not print WSTOKEN within ${timeoutMs}ms`)
  }

  /**
   * Copy this backend's log where a failed CI run can actually read it.
   *
   * The log lives beside the disposable root — a mkdtemp nobody keeps and no
   * artifact step collects — so when a spec failed on the runner, the one
   * account of what the backend did was thrown away with the temp directory.
   * Every diagnosis then had to be guessed from the DOM. test-results/ is
   * already uploaded on failure (ci.yml), so that is where it goes.
   *
   * Best-effort by construction: a harness that throws while trying to explain
   * a failure replaces the failure with its own.
   */
  private preserveLog(): void {
    if (!this.logPath) return
    try {
      const dir = resolve(process.cwd(), 'test-results', 'devharness')
      mkdirSync(dir, { recursive: true })
      copyFileSync(this.logPath, resolve(dir, basename(this.logPath)))
    } catch {
      /* the log is a courtesy; never fail a run over it */
    }
  }

  /** The backend's log so far, for a test that wants to say WHY it failed. */
  logTail(maxBytes = 4000): string {
    if (!this.logPath) return '(backend never started)'
    try {
      const all = readFileSync(this.logPath, 'utf8')
      return all.length <= maxBytes ? all : `…${all.slice(-maxBytes)}`
    } catch (err) {
      return `(backend log unreadable: ${String(err)})`
    }
  }

  /** Stop the running devharness. */
  stop(): void {
    this.preserveLog()
    if (!this.proc) return
    const p = this.proc
    this.proc = null
    try {
      p.kill('SIGTERM')
    } catch {
      /* already dead */
    }
    // Give it 2 s to shut down gracefully, then SIGKILL.
    try {
      execSync(`timeout 2 sh -c 'while kill -0 ${p.pid} 2>/dev/null; do sleep 0.1; done'`)
    } catch {
      /* the wait timed out — fall through to SIGKILL */
    }
    try {
      p.kill('SIGKILL')
    } catch {
      /* fine */
    }
  }
  async restart(port: number): Promise<BackendEndpoint> {
    this.stop()
    // Brief quiescent period so the OS releases the old listen socket.
    const { promise, resolve: wait } = Promise.withResolvers<void>()
    setTimeout(wait, 500)
    await promise
    return this.start(port)
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  /**
   * The canonical home this backend was launched with, for a spec that wants to
   * assert the backend actually resolved it rather than trust that it was
   * handed over. Throws before the first start(), because there is no honest
   * answer then and returning a guess is how an unchecked boundary starts.
   */
  get isolatedHome(): string {
    if (!this.isolation) throw new Error('backend has not been started yet')
    return this.isolation.isolatedHome
  }
}
