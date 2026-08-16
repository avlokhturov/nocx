// vitest setup: polyfill browser APIs that jsdom does not ship.
// jsdom does not provide ResizeObserver, so we supply a minimal stub
// that never fires — enough for unit tests that don't depend on layout.

import { afterAll, beforeAll } from 'vitest'

if (typeof window !== 'undefined' && typeof window.localStorage === 'undefined') {
  let values = new Map<string, string>()
  const storage = {
    get length() {
      return values.size
    },
    clear() {
      values = new Map()
    },
    getItem(key: string) {
      return values.get(key) ?? null
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null
    },
    removeItem(key: string) {
      values.delete(key)
    },
    setItem(key: string, value: string) {
      values.set(key, String(value))
    },
  } as Storage
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
}

if (typeof ResizeObserver === 'undefined') {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// jsdom does not implement HTMLDialogElement.prototype.showModal/close as of
// jsdom 25. Provide these methods so tests using showModal() work.
// The `open` property and `returnValue` already exist on instances via IDL.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    if (this.open) {
      throw new DOMException(
        'Failed to execute "showModal" on HTMLDialogElement: The element already has an "open" attribute, and therefore cannot be opened modally.',
      )
    }
    this.open = true
  }

  HTMLDialogElement.prototype.close = function (returnValue?: string) {
    if (!this.open) return
    this.open = false
    if (returnValue !== undefined) this.returnValue = returnValue
    this.dispatchEvent(new Event('close', { bubbles: false }))
  }
}

// jsdom implements no scrolling at all, so Element.scrollIntoView and
// Element.scrollTo are simply absent. The scrollback controller calls both,
// and setIdle schedules its scrollIntoView a frame late on purpose — so the
// callback lands after the test that caused it has finished, and the
// TypeError surfaces as an unhandled rejection attributed to whichever file
// happens to be running. There is no layout in jsdom, so doing nothing is
// the honest stub; a test that cares about scrolling asserts on the mode and
// the classes, never on a scroll position that cannot exist here.
if (typeof Element !== 'undefined') {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
}

// jsdom (≤ 25) does not implement Range.getClientRects; CodeMirror 6 calls it
// to measure text geometry (coordsAtPos, measureTextSize). There is no layout
// in jsdom, so an empty rect list is the honest answer — it stops CM6 from
// crashing on the measurement path while never fabricating geometry.
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => []
}

// A timer armed while the module graph loads must not outlive the jsdom it
// was armed in. @wailsio/runtime bought this: importing it arms a 50 ms
// polling interval (dist/drag.js, waiting for the window environment) and a
// frame callback (dist/appregion.js). Neither belongs to any test and
// nothing ever clears them, so a file that finishes in under 50 ms — most
// of them — is torn down with the interval still armed. The tick then runs
// against a dead environment, throws "window is not defined" as an uncaught
// exception, and the runner attributes it to whichever file happened to be
// in flight while every test in the run passes. Measured on this tree: 28
// jsdom files reach the real runtime through log.ts and clipboard.ts and
// every one of them arms both timers, so the file the runner names is a
// lottery rather than the defect.
//
// The sweep is deliberately confined to what module evaluation armed, and
// the natives go back before the first test runs. A timer a TEST arms
// belongs to the product, and one left running there is a real defect —
// exactly the kind this same uncaught-exception report is how we find out
// about. So this must never grow into a general "clear every timer at the
// end", which would make that whole class invisible.
if (typeof window !== 'undefined') {
  const armedIntervals = new Map<number, () => void>()
  const armedTimeouts = new Map<number, () => void>()

  const nativeSetInterval = window.setInterval.bind(window)
  const nativeClearInterval = window.clearInterval.bind(window)
  const nativeSetTimeout = window.setTimeout.bind(window)
  const nativeClearTimeout = window.clearTimeout.bind(window)

  // Recording stops when the first test starts. The wrappers stay installed
  // rather than being swapped back, so nothing here writes to a global after
  // setup — which is what keeps it clear of a file that installs fake timers
  // while it loads, and of vi.useFakeTimers() inside a test.
  let recording = true

  window.setInterval = ((...args: Parameters<typeof nativeSetInterval>) => {
    const id = nativeSetInterval(...args)
    if (recording) armedIntervals.set(id, () => nativeClearInterval(id))
    return id
  }) as typeof window.setInterval

  window.setTimeout = ((...args: Parameters<typeof nativeSetTimeout>) => {
    const id = nativeSetTimeout(...args)
    if (recording) armedTimeouts.set(id, () => nativeClearTimeout(id))
    return id
  }) as typeof window.setTimeout

  window.clearInterval = ((id?: number) => {
    if (typeof id === 'number') armedIntervals.delete(id)
    nativeClearInterval(id)
  }) as typeof window.clearInterval

  window.clearTimeout = ((id?: number) => {
    if (typeof id === 'number') armedTimeouts.delete(id)
    nativeClearTimeout(id)
  }) as typeof window.clearTimeout

  // Module evaluation is over once the first hook runs.
  beforeAll(() => {
    recording = false
  })

  // The last thing that happens before jsdom goes away.
  afterAll(() => {
    for (const disarm of armedIntervals.values()) disarm()
    for (const disarm of armedTimeouts.values()) disarm()
    armedIntervals.clear()
    armedTimeouts.clear()
  })
}
