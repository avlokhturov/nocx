// Where the app under test answers, decided once.
//
// The config needs it to set baseURL and to know what to wait for; the harness
// needs it because a worker-scoped fixture opens its own page and
// browser.newPage() inherits nothing from `use`. Two derivations of one answer
// is what this file exists to prevent — they agree until the day someone
// changes a port in one of them, and then a run silently measures the wrong
// process (the reason the port is env-derived in the first place).
//
// There used to be a second answer here: a HEADLESS flag that switched the
// whole suite between `wails dev` on 34115 and vite on 5173, depending on
// whether the caller had started a backend. Two arrangements for one suite is
// what let seven specs be excluded from one of them by a hand-written list,
// and what made "where is the home" a question with two right answers. The
// stand is now Playwright's (e2e/stand.ts) and there is one answer.

// The port is env-derived rather than a constant because it is a shared
// resource. Two runs on one machine that both assume the same port do not
// merely compete: the second attaches to the first one's app and reports
// results for a tree it never built.
export const WEB_PORT = process.env.NOCX_WEB_PORT ? Number(process.env.NOCX_WEB_PORT) : 5173
export const BASE_URL = `http://127.0.0.1:${WEB_PORT}`

// The wails host answers here. Only the `wails-host` project uses it: what it
// proves is the desktop shell's own seam — the assets wails serves and the
// real window.go it injects — which is a different subject from the suite.
export const WAILS_PORT = process.env.NOCX_WAILS_PORT ? Number(process.env.NOCX_WAILS_PORT) : 34115
export const WAILS_URL = `http://localhost:${WAILS_PORT}`
