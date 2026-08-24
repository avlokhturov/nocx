// @vitest-environment jsdom
//
// The floating Attach button (nocx-a7mw7.1): a selection inside a finished
// block's output OFFERS to be attached; the button is the only thing that
// attaches. This file owns the affordance's own contract — the kit Button
// it renders, the position math (below the selection's last client rect,
// flipped above when there is no room below, clamped to the viewport), and
// that a press never steals the caret or the selection. The gesture's
// integration (selection → offer → press → exactly one chip) lives in
// terminal-content.test.ts; the pure position math lives here because jsdom
// does no layout, so the module is the honest seam for geometry.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachButtonPosition,
  createAttachAffordance,
  SELECTION_GAP_PX,
} from './attach-affordance'
import { EDGE_MARGIN_PX } from './ui/menu-geometry'

/** A selection end in viewport coordinates — the "last client rect" of a
 *  real selection, which the surface hands the affordance. */
function anchorAt(opts: Partial<{ left: number; top: number; right: number; bottom: number }> = {}) {
  return {
    left: opts.left ?? 100,
    top: opts.top ?? 200,
    right: opts.right ?? 300,
    bottom: opts.bottom ?? 220,
  }
}

const SIZE = { width: 80, height: 32 }
const VIEWPORT = { width: 800, height: 600 }

afterEach(() => {
  document.body.replaceChildren()
})

describe('attachButtonPosition', () => {
  it('anchors below the selection\'s last client rect, right edge at the selection\'s end', () => {
    const { left, top } = attachButtonPosition(anchorAt(), SIZE, VIEWPORT)
    expect(left).toBe(300) // anchor.right
    expect(top).toBe(220 + SELECTION_GAP_PX) // anchor.bottom + gap
  })

  it('flips above the selection when there is no room below it', () => {
    // bottom 595 with a 600-high viewport: below + gap + margin does not fit.
    const anchor = anchorAt({ top: 560, bottom: 595 })
    const { top } = attachButtonPosition(anchor, SIZE, VIEWPORT)
    expect(top).toBe(560 - SELECTION_GAP_PX - SIZE.height)
    expect(top + SIZE.height + EDGE_MARGIN_PX).toBeLessThanOrEqual(VIEWPORT.height)
  })

  it('clamps to the viewport instead of running off its edges', () => {
    // The selection ends past the right edge: the button's right edge may
    // not pass the viewport's.
    const right = attachButtonPosition(anchorAt({ right: 790 }), SIZE, VIEWPORT)
    expect(right.left).toBe(VIEWPORT.width - SIZE.width - EDGE_MARGIN_PX)
    // The selection is at the very top: even flipped above, the button must
    // keep its margin rather than leaving the window.
    const top = attachButtonPosition(anchorAt({ top: 2, bottom: 590 }), SIZE, VIEWPORT)
    expect(top.top).toBe(EDGE_MARGIN_PX)
  })
})

describe('createAttachAffordance', () => {
  it('renders the kit\'s Button (primary, sm, labelled Attach) inside a fixed wrapper at body level', () => {
    const affordance = createAttachAffordance(() => {})
    try {
      const wrapper = document.body.querySelector<HTMLElement>('.attach-affordance')
      expect(wrapper).not.toBeNull()
      expect(wrapper?.style.position).toBe('fixed')
      const btn = wrapper?.querySelector<HTMLButtonElement>('.ui-button')
      expect(btn).not.toBeNull()
      expect(btn?.getAttribute('data-variant')).toBe('primary')
      expect(btn?.getAttribute('data-size')).toBe('sm')
      expect(btn?.textContent).toBe('Attach')
      expect(btn?.getAttribute('aria-label')).not.toBeNull()
    } finally {
      affordance.dispose()
    }
  })

  it('is hidden until shown, and show() places it near the selection end', () => {
    const affordance = createAttachAffordance(() => {})
    try {
      const wrapper = document.body.querySelector<HTMLElement>('.attach-affordance')!
      expect(affordance.visible).toBe(false)
      expect(wrapper.style.display).toBe('none')
      affordance.show(anchorAt(), VIEWPORT)
      expect(affordance.visible).toBe(true)
      expect(wrapper.style.display).not.toBe('none')
      // Anchored below the selection's last rect (jsdom measures the button
      // as 0×0, so the position is the anchor's own, unclamped).
      expect(wrapper.style.left).toBe('300px')
      expect(wrapper.style.top).toBe(`${220 + SELECTION_GAP_PX}px`)
      affordance.hide()
      expect(affordance.visible).toBe(false)
      expect(wrapper.style.display).toBe('none')
    } finally {
      affordance.dispose()
    }
  })

  it('fires onAttach when the button is pressed — once per press', () => {
    const onAttach = vi.fn()
    const affordance = createAttachAffordance(onAttach)
    try {
      affordance.show(anchorAt(), VIEWPORT)
      const btn = document.body.querySelector<HTMLButtonElement>('.attach-affordance .ui-button')!
      btn.click()
      expect(onAttach).toHaveBeenCalledTimes(1)
      btn.click()
      expect(onAttach).toHaveBeenCalledTimes(2)
    } finally {
      affordance.dispose()
    }
  })

  it('a press never steals the caret: mousedown on the affordance is prevented', () => {
    const affordance = createAttachAffordance(() => {})
    try {
      affordance.show(anchorAt(), VIEWPORT)
      const btn = document.body.querySelector<HTMLButtonElement>('.attach-affordance .ui-button')!
      // The browser's mousedown default would collapse the document
      // selection and move focus; the affordance must stop it (nocx-4wtlh:
      // attaching does not touch the selection).
      const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      btn.dispatchEvent(md)
      expect(md.defaultPrevented).toBe(true)
    } finally {
      affordance.dispose()
    }
  })

  it('dispose() tears the wrapper out of the document', () => {
    const affordance = createAttachAffordance(() => {})
    expect(document.body.querySelector('.attach-affordance')).not.toBeNull()
    affordance.dispose()
    expect(document.body.querySelector('.attach-affordance')).toBeNull()
  })
})
