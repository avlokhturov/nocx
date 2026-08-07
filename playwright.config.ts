import { defineConfig, type Project } from '@playwright/test'

import { BASE_URL } from './e2e/base-url'

// e2e drives the whole app, not the frontend alone: the stand this config
// starts is cmd/devharness — the real Go backend on a real PTY, the real
// transport — with vite serving the real renderer. That is the only place
// layout, focus and GPU behaviour are observable; jsdom has none of them.
//
// ONE arrangement. There used to be two — `wails dev` here and a shell script
// that started devharness and set NOCX_WS_PORT — and seven specs could only
// run on the second, kept off the first by a hand-written list. That is how
// seven files failed on their first line while the shards stayed green
// (nocx-azxe.2), and how "where is the home" became a question with two right
// answers. e2e/stand.ts owns the lifecycle now and e2e/check-coverage.mjs is
// the receipt that no spec file is left uncollected.
//
// wails is not started here. What the desktop host proves — the assets it
// serves and the real window.go it injects — is its own subject, and it has
// its own project rather than being the platform every spec pays for.
//
// Ports and URLs live in e2e/base-url.ts: the harness needs the same answer for
// the worker-scoped readiness page it opens itself, and a second copy here
// would agree until someone changed one of them.

// Both browsers stay declared. WebKit is not redundant coverage: nocx-q18's
// glyph corruption reproduces in WKWebView and not in Chromium, and WebKit is
// the closest Playwright can get to the real app. Dropping it from the default
// would leave that class of regression unwatched, so the lever here selects a
// SUBSET for a cheap run rather than narrowing what the suite knows about.
//
//   PW_PROJECTS=chromium   → one browser, roughly half the work
//   unset                  → both, which is what CI should keep doing
const ALL_PROJECTS: Project[] = [
  { name: 'chromium', use: { browserName: 'chromium' } },
  { name: 'webkit', use: { browserName: 'webkit' } },
]
const wanted = process.env.PW_PROJECTS?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const projects = wanted?.length
  ? ALL_PROJECTS.filter((p) => wanted.includes(p.name!))
  : ALL_PROJECTS
if (wanted?.length && projects.length === 0) {
  throw new Error(
    `PW_PROJECTS=${process.env.PW_PROJECTS} matched no project; known: ${ALL_PROJECTS.map((p) => p.name).join(', ')}`,
  )
}

export default defineConfig({
  testDir: './e2e',

  timeout: 60_000,

  // Playwright's expect timeout is 5 seconds, which is a library default and
  // was never a statement about this app on this hardware.
  //
  // Every spec opens by asserting the first tab exists, and on the CI runner
  // that assertion was failing across the suite — 86 of 200 in run 31087876366
  // — with "resolved to 0 elements" while the error-context snapshot captured
  // moments later showed the tab present. So the tab arrives; it arrives after
  // five seconds. Under `wails dev` each page.goto is a full reload: vite
  // transforms modules on demand, the renderer re-establishes the WebSocket,
  // and the backend spawns a PTY for the new session. That is seconds of real
  // work on a shared macOS runner, and none of it is what the specs are about.
  //
  // The cost is bounded and paid only when something is genuinely wrong: an
  // assertion that would fail still fails, 15 seconds later than it used to,
  // and the per-test timeout above is unchanged so a hung test is still cut off
  // at 60s. What this buys back is a suite whose failures mean something
  // (nocx-qth1).
  expect: { timeout: 20_000 },

  // Refuse to start when the disk is nearly full.
  //
  // Scope honestly: this is a floor on STARTING, not a bound on consumption. The
  // largest consumer here is not the suite at all — a crashing browser process
  // can write a multi-gigabyte core dump in seconds, which no test-side setting
  // can throttle. That is handled outside the repo by capping dump size. What
  // this guard buys is refusing to begin a run on a filesystem that is already
  // too full to survive one.
  // The stand — cmd/devharness plus vite — is brought up here and taken down
  // in globalTeardown, so `npx playwright test` is the whole command on a
  // developer's machine and in CI. preflight's disk floor runs first.
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  // One worker by default, because the default must assume this process is NOT
  // alone on the machine. With one worker per run, total browsers equals the
  // number of runs — the only bound that stays predictable as concurrency grows.
  // A higher number is correct on a dedicated machine and is one env var away.
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 1,

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects,
})
