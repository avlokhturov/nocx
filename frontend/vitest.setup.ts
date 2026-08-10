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
