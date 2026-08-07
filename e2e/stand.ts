/**
 * The stand: the backend and the frontend the suite runs against, owned by
 * Playwright itself.
 *
 * # Why this exists
 *
 * The suite used to run two ways. `npx playwright test` started `wails dev`;
 * `e2e/headless-run.sh` started cmd/devharness plus vite and set NOCX_WS_PORT,
 * which switched the config to a second arrangement. Seven specs could only
 * run on the second, so a hand-written testIgnore list kept them off the first
 * and a separate CI job ran them — which is how seven files once failed on
 * their first line while the shards stayed green (nocx-azxe.2).
 *
 * Two arrangements is also what produced three separate defects in one day:
 * specs that answered "where is the home" or "where do documents live" for
 * themselves, and got it right on one path and wrong on the other. A known_hosts
 * written to the wrong home is a host key the backend never sees.
 *
 * So there is one stand and Playwright owns it. `npx playwright test` is the
 * whole command, on a developer's machine and in CI, and there is no second
 * entry point that can drift from it.
 *
 * # Why a manifest file rather than environment variables
 *
 * The backend mints its token at startup, and a child process cannot put a
 * value back into its parent's environment — so `webServer.env` cannot carry
 * something that does not exist until after the server starts. The stand
 * publishes what it made to `.e2e/stand.json` and the harness reads it there.
 * One authoritative answer, written once, instead of a port and a token
 * travelling separately through three processes.
 *
 * The file is also the account of a run that has finished: what home it used,
 * what port it held, which binary it built.
 *
 * # What it does NOT do
 *
 * It does not start wails. The wails host has its own project and its own
 * fixture, because what that proves — the injected bindings, the assets wails
 * serves, a clean shutdown — is a different subject from what the suite is
 * about, and it needs the real window.go rather than a stub.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { createHomeIsolation } from './home-isolation'

const repoRoot = path.resolve(__dirname, '..')

/** Where the run publishes what it built. Under the repo, git-ignored, and
 *  deliberately not a mkdtemp: a finished run leaves it behind to be read. */
export const MANIFEST = path.join(repoRoot, '.e2e', 'stand.json')

export interface StandManifest {
  /** The backend's WebSocket port, as the backend reported it. */
  port: number
  /** The token the backend minted for this run. */
  token: string
  /** The disposable HOME the backend resolved. */
  home: string
  /** Where vite is serving the frontend. */
  baseURL: string
  /** The devharness build this run made, for specs that start their own. */
  devharness: string
}

/** Read what the stand published. Throws with the reason rather than a
 *  TypeError on undefined, because "the stand is not up" and "the stand is up
 *  and the port is wrong" are different failures and only one is the caller's
 *  fault. */
export function readStand(): StandManifest {
  try {
    return JSON.parse(readFileSync(MANIFEST, 'utf8')) as StandManifest
  } catch (err) {
    throw new Error(
      [
        `e2e stand: no usable manifest at ${MANIFEST} (${(err as Error).message}).`,
        '',
        'The stand is started by playwright.config.ts globalSetup, so this means',
        'either the run did not start it or it failed on the way up. Its logs are',
        'kept under test-results/stand/.',
      ].join('\n'),
    )
  }
}

/**
 * Take the host's login shell out of what the backend inherits.
 *
 * `internal/pty` reads `$SHELL` first and only goes looking when it is unset,
 * so leaving it in means the suite drives whatever shell the developer happens
 * to log in with — bash in the e2e container, zsh on a stock Mac. That is not a
 * cosmetic difference: `nocx.bash` emits the OSC 636 command snapshot and
 * `nocx.zsh` emits only the readiness passport, so the shell decides whether
 * tab completion ever learns a command name. completion.spec.ts was green in
 * the container and red on the macOS runner for exactly that reason, and it
 * took a day and a trace download to find out (nocx-qduc, nocx-z9s9.9).
 *
 * Stripped rather than pinned to a path: there is no one path. `/bin/bash` is
 * absent on NixOS, where bash lives under /run/current-system. What has to be
 * the same on every host is the POLICY, and the backend already owns it —
 * prefer bash, fall through a candidate list, /bin/sh as the last resort — and
 * now logs which one it took.
 *
 * This is deliberately NOT in home-isolation's restricted list. That list is
 * the home boundary, and overriding one of its keys raises. `$SHELL` cannot
 * reach outside the boundary — whichever shell starts reads its rc files from
 * the disposable home — so this is determinism, not containment, and the two
 * should not share a mechanism that refuses.
 */
function withoutHostShell(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'SHELL'))
}

let backend: ChildProcess | null = null
let vite: ChildProcess | null = null
let logDir = ''

function waitFor(what: string, probe: () => boolean, proc: ChildProcess, log: () => string) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (probe()) return resolve()
      if (proc.exitCode !== null) {
        return reject(new Error(`e2e stand: ${what} exited before it was ready:\n${log()}`))
      }
      if (Date.now() - started > 120_000) {
        return reject(new Error(`e2e stand: ${what} was not ready within 120s:\n${log()}`))
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

/** Bring the stand up and publish it. Idempotent per process. */
export async function startStand(): Promise<StandManifest> {
  const root = path.join(repoRoot, '.e2e')
  logDir = path.join(repoRoot, 'test-results', 'stand')
  mkdirSync(logDir, { recursive: true })

  // A FRESH home every run. The home used to survive from one run to the next,
  // so a spec's preconditions were whatever the last run happened to leave —
  // an installed-facts document, a saved profile, a vault. That is half of
  // nocx-8rda, and the half a run can fix for itself: a spec asserting "this
  // machine has never done X" is only meaningful against a home where nothing
  // has. What it does NOT fix is one spec's writes reaching the next spec
  // WITHIN a run; that needs a home per test and a backend to match.
  //
  // The directory is still under the repo rather than a mkdtemp, so a failure
  // can be inspected afterwards — it is removed on the way UP, not on the way
  // down, which keeps the evidence of the run that just failed.
  rmSync(path.join(root, 'home'), { recursive: true, force: true })

  // The boundary, from the one module that owns it — not a second hand-copied
  // list of variables to strip. NOCX_NO_SYSTEM_KEYSTORE is the switch that
  // stops app.New probing the OS keystore, which on macOS is a real keychain
  // write and, under a disposable home with no login keychain, a dialog per
  // backend start (nocx-o4hg).
  const isolation = createHomeIsolation({
    inheritedEnv: withoutHostShell(process.env),
    overrideEnv: { NOCX_NO_SYSTEM_KEYSTORE: '1' },
    root,
  })

  // Built, not `go run`: go run wraps the binary in a child that survives a
  // kill of the parent, and an orphaned backend holds the WS port against the
  // next run.
  const devharness = path.join(root, 'devharness')
  execFileSync('go', ['build', '-o', devharness, './cmd/devharness'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })

  const wsPort = Number(process.env.NOCX_WS_PORT ?? 9876)
  const webPort = Number(process.env.NOCX_WEB_PORT ?? 5173)
  const baseURL = `http://127.0.0.1:${webPort}`

  let backendLog = ''
  backend = spawn(devharness, [], {
    cwd: repoRoot,
    env: { ...isolation.env, NOCX_WS_ADDR: `127.0.0.1:${wsPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backend.stdout?.on('data', (b: Buffer) => (backendLog += b.toString()))
  backend.stderr?.on('data', (b: Buffer) => (backendLog += b.toString()))

  // WSTOKEN is printed after WSPORT, so waiting on it means both are readable.
  await waitFor(
    'backend',
    () => /^WSTOKEN=/m.test(backendLog),
    backend,
    () => backendLog,
  )
  const port = Number(/^WSPORT=(\d+)$/m.exec(backendLog)?.[1])
  const token = /^WSTOKEN=(.+)$/m.exec(backendLog)?.[1]?.trim()
  if (!port || !token) {
    throw new Error(`e2e stand: backend never reported WSPORT/WSTOKEN:\n${backendLog}`)
  }

  let viteLog = ''
  vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: path.join(repoRoot, 'frontend'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stdout?.on('data', (b: Buffer) => (viteLog += b.toString()))
  vite.stderr?.on('data', (b: Buffer) => (viteLog += b.toString()))
  await waitFor(
    'vite',
    () => /ready in|Local:/i.test(viteLog),
    vite,
    () => viteLog,
  )

  const manifest: StandManifest = {
    port,
    token,
    home: isolation.isolatedHome,
    baseURL,
    devharness,
  }
  // Written through a temp name: a reader that catches the file half-written
  // gets a parse error blamed on the stand rather than on itself.
  const tmp = `${MANIFEST}.tmp`
  writeFileSync(tmp, JSON.stringify(manifest, null, 2))
  renameSync(tmp, MANIFEST)

  const flush = () => {
    writeFileSync(path.join(logDir, 'backend.log'), backendLog)
    writeFileSync(path.join(logDir, 'vite.log'), viteLog)
  }
  flush()
  standFlush = flush

  return manifest
}

let standFlush: (() => void) | null = null

/** Take the stand down and keep its account. */
export async function stopStand(): Promise<void> {
  standFlush?.()
  for (const proc of [vite, backend]) {
    if (proc === null || proc.exitCode !== null) continue
    proc.kill('SIGTERM')
  }
  // Wait for them to actually go before anything removes the directory they
  // are writing into: on macOS the shell integration is still flushing into
  // $HOME as the process dies, and the race reports "Directory not empty".
  await Promise.all(
    [vite, backend].map(
      (proc) =>
        new Promise<void>((resolve) => {
          if (proc === null || proc.exitCode !== null) return resolve()
          const hard = setTimeout(() => proc.kill('SIGKILL'), 10_000)
          proc.on('exit', () => {
            clearTimeout(hard)
            resolve()
          })
        }),
    ),
  )
  vite = null
  backend = null
  rmSync(MANIFEST, { force: true })
}
