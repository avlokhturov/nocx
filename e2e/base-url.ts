// Where the app under test answers, decided once.
//
// The config needs it to set baseURL and to know what to wait for; the harness
// needs it because a worker-scoped fixture opens its own page and
// browser.newPage() inherits nothing from `use`. Two derivations of one answer
// is what this file exists to prevent — they agree until the day someone
// changes a port in one of them, and then a run silently measures the wrong
// process (the reason the port is env-derived in the first place).

// The port is env-derived rather than a constant because it is a shared
// resource. Two runs on one machine that both assume the same port do not
// merely compete: the second attaches to the first one's app and reports
// results for a tree it never built.
export const WAILS_PORT = process.env.NOCX_WAILS_PORT ? Number(process.env.NOCX_WAILS_PORT) : 34115
export const WAILS_URL = `http://localhost:${WAILS_PORT}`

// Headless path: when NOCX_WS_PORT is set, the runner has started devharness
// (Go backend + WebSocket) and vite (frontend dev server) separately. No wails
// or GTK required — Playwright drives a plain browser against the vite URL.
// This path is also far cheaper: it skips the Go compile and frontend build
// that `wails dev` performs on every cold start.
export const HEADLESS = !!process.env.NOCX_WS_PORT

export const BASE_URL = HEADLESS ? process.env.NOCX_BASE_URL || 'http://localhost:5173' : WAILS_URL
