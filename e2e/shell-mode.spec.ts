import { test, expect } from './harness'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Page } from './harness'

// ── Shell-mode happy path (nocx-4t37.2) ───────────────────────────────────
// The epic's acceptance: a user who has never read the docs lands on a plain
// SSH shell, SEES the capability statement, switches it to nocxify, and gets
// blocks — one automated check, end to end, against a REAL shell on a REAL
// PTY. The fixture (cmd/e2e-sshd) is an in-process SSH server that actually
// executes commands, so the in-band bootstrap runs for real and the OSC 133
// markers are the shell's own.

const E2E_HOME = path.resolve(__dirname, '..', '.e2e', 'home')

interface Fixture {
  proc: ChildProcess
  addr: string
  userKey: string
  knownHosts: string
}

/** Build (once per run) and spawn the in-process sshd; read its handshake. */
function startSshd(): Fixture {
  const bin = path.resolve(
    process.env.TMPDIR ?? '/tmp',
    `nocx-e2e-sshd-${process.pid}-${Date.now()}`,
  )
  if (!existsSync(bin)) {
    execFileSync('go', ['build', '-o', bin, './cmd/e2e-sshd'], {
      cwd: path.resolve(__dirname, '..'),
    })
  }
  const proc = spawn(bin, [], { stdio: ['ignore', 'pipe', 'inherit'] })
  const lines: string[] = []
  let addr = ''
  let userKey = ''
  let knownHosts = ''
  const deadline = Date.now() + 15_000
  // The fixture prints ADDR/USERKEY/KNOWNHOSTS/READY then serves forever.
  const reader = new Promise<void>((resolve, reject) => {
    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        lines.push(trimmed)
        if (trimmed.startsWith('ADDR=')) addr = trimmed.slice(5)
        if (trimmed.startsWith('USERKEY=')) userKey = trimmed.slice(8)
        if (trimmed.startsWith('KNOWNHOSTS=')) knownHosts = trimmed.slice(11)
        if (trimmed === 'READY') resolve()
      }
      if (Date.now() > deadline)
        reject(new Error(`e2e-sshd did not print READY: ${lines.join('|')}`))
    })
    proc.on('exit', (code) =>
      reject(new Error(`e2e-sshd exited early (${code}): ${lines.join('|')}`)),
    )
  })
  return {
    proc,
    get addr() {
      return addr
    },
    get userKey() {
      return userKey
    },
    get knownHosts() {
      return knownHosts
    },
    _wait: reader,
  } as Fixture & { _wait: Promise<void> }
}

/** Seed the isolated home's known_hosts so the backend's ssh client accepts
 *  the fixture's host key (the devharness runs with that HOME). The file is
 *  REPLACED, not appended: every fixture spawn mints fresh keys, and a stale
 *  line for a dead key makes the backend refuse the connection. */
function trustHostKey(fixture: Fixture): void {
  const sshDir = path.join(E2E_HOME, '.ssh')
  mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(sshDir, 'known_hosts'), fixture.knownHosts + '\n')
}

/** Call one JSON-RPC method over the real backend socket, as the app does. */
async function rpc<T>(
  page: Page,
  port: number,
  token: string,
  method: string,
  params: unknown,
): Promise<T> {
  return page.evaluate(
    ({ port, token, method, params }) =>
      new Promise<T>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/session`, [`nocx.token.${token}`])
        const timer = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 10_000)
        ws.onopen = () => {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
        }
        ws.onmessage = (ev: MessageEvent) => {
          const msg = JSON.parse(String(ev.data)) as { result?: T; error?: { message?: string } }
          clearTimeout(timer)
          ws.close()
          if (msg.error) reject(new Error(`${method}: ${msg.error.message ?? 'rpc error'}`))
          else resolve(msg.result as T)
        }
        ws.onerror = () => {
          clearTimeout(timer)
          reject(new Error(`${method}: websocket error`))
        }
      }),
    { port, token, method, params },
  )
}

test('a plain SSH shell shows the capability, switching to nocxify produces blocks', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const fixture = startSshd()
  try {
    await (fixture as Fixture & { _wait: Promise<void> })._wait
    expect(fixture.addr).not.toBe('')
    trustHostKey(fixture)

    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    // Read the backend port/token through the bindings (stubbed on the
    // headless path, real under wails dev) — the same seam auth.spec uses.
    const wsInfo = await page.evaluate(async () => {
      const w = window as unknown as Record<string, unknown>
      const main = (w.go as Record<string, unknown>).main as Record<string, unknown>
      const app = main.WailsApp as {
        GetWSPort: () => Promise<number>
        GetWSToken: () => Promise<string>
      }
      return { port: await app.GetWSPort(), token: await app.GetWSToken() }
    })

    // Seed the connection the way Settings would: a profile pointing at the
    // fixture, with shellIntegration ask — the mode the epic's happy path
    // starts from (plain shell, capability visible). The name is unique per
    // run: the devharness store persists across runs in this home, and a
    // stale profile from an earlier run would dial a dead fixture.
    const profileName = `e2e-fixture-${Date.now()}`
    await rpc(page, wsInfo.port, wsInfo.token, 'profiles.create', {
      type: 'ssh',
      name: profileName,
      options: {
        host: fixture.addr.split(':')[0],
        port: Number(fixture.addr.split(':')[1]),
        user: 'e2e',
        keyPath: fixture.userKey,
        shellIntegration: 'ask',
      },
    })

    // Open the connection through quick connect: the palette's host search
    // reaches a saved profile and Enter opens it DIRECTLY (no vault
    // preflight — the profile's key is file-based), which is the user path
    // the epic's happy path describes.
    await page.keyboard.press('Control+Shift+P')
    const search = page.locator('.quick-connect__search input')
    await expect(search).toBeVisible()
    await search.fill(profileName)
    await page.keyboard.press('Enter')

    // The SSH tab opens; the plain shell (ask policy) shows the recovery
    // action in the editor chrome: Integrate this shell.
    const recovery = page.locator('.pane.active .nocx-editor-recovery')
    await expect(recovery).toBeVisible({ timeout: 20_000 })
    await expect(recovery).toHaveText('Integrate this shell', { timeout: 20_000 })

    // Click the recovery chip — it IS the action, no popover.
    await recovery.click()
    // The in-band bootstrap runs against the REAL shell; the shell's own
    // hooks then emit OSC 133 markers. The healthy state shows nothing.
    await expect(recovery).not.toBeVisible({ timeout: 20_000 })

    // The user then runs a command through the nocx editor, and it becomes
    // a block — the epic's "switches it to nocxify, and gets blocks".
    const editor = page.locator('.pane.active .nocx-editor-input')
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await editor.click()
    await editor.pressSequentially('echo hello-from-e2e')
    await editor.press('Enter')
    const block = page.locator('.pane.active .cmd-block', {
      hasText: 'hello-from-e2e',
    })
    await expect(block.first()).toBeVisible({ timeout: 30_000 })
  } finally {
    fixture.proc.kill('SIGKILL')
  }
})
