import { defineConfig } from '@playwright/test'

// e2e drives the whole app, not the frontend alone: `wails dev` serves the
// built UI *and* the bound Go methods at :34115, so a test here exercises the
// real transport, the real PTY and the real renderer. That is the only place
// layout, focus and GPU behaviour are observable — jsdom has none of them.
const WAILS_PORT = 34115
const WAILS_URL = `http://localhost:${WAILS_PORT}`

// Headless path: when NOCX_WS_PORT is set, the runner has started devharness
// (Go backend + WebSocket) and vite (frontend dev server) separately. No wails
// or GTK required — Playwright drives a plain browser against the vite URL.
const HEADLESS = !!process.env.NOCX_WS_PORT
const BASE_URL = HEADLESS
  ? process.env.NOCX_BASE_URL || 'http://localhost:5173'
  : WAILS_URL

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
      // nocx-q18: the glyph corruption reproduces in WKWebView but not
      // Chromium; WebKit is the closest Playwright can get to the real app.
    },
  ],

  // The suite starts its own app: a test that silently needs a `wails dev`
  // someone remembered to launch is red on a clean machine for a reason that
  // has nothing to do with the code under test, and green only by luck.
  //
  // reuseExistingServer attaches to a dev session already running on :34115 so
  // local runs stay instant; CI always builds its own. The timeout is sized for
  // a cold `wails dev`, which compiles the Go binary and installs/builds the
  // frontend before it ever listens.
  //
  // gracefulShutdown is load-bearing, not politeness. `wails dev` starts the
  // frontend watcher in a process group of its own (Setpgid in the wails CLI),
  // so no group kill aimed at wails can reach it; wails reaps it itself, from a
  // SIGTERM handler, on the way out. Playwright's default is to SIGKILL the
  // group — that handler never runs, vite is orphaned, and because it inherited
  // the run's stdio the pipe never closes and the run hangs long after the last
  // test. On a runner that is a job burning its timeout rather than failing.
  //
  // In headless mode the caller owns both processes; skip the webServer stanza.
  ...(!HEADLESS
    ? {
        webServer: {
          command: 'wails dev',
          url: WAILS_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 240_000,
          gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      }
    : {}),
})
