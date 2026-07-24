// vitest setup: polyfill browser APIs that jsdom does not ship.
// jsdom does not provide ResizeObserver, so we supply a minimal stub
// that never fires — enough for unit tests that don't depend on layout.

if (typeof ResizeObserver === 'undefined') {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
