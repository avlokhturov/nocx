// The floating Attach button (nocx-a7mw7.1): a selection inside a finished
// block's output OFFERS to be attached; the button is the only thing that
// attaches. The kit's Button (variant="primary", size="sm") inside a
// surface-owned fixed-position wrapper — this module owns the wrapper and
// the position math, the kit owns the paint (frontend/src/ui/README.md:
// a surface may PLACE a kit component and never repaint it).
//
// The wrapper renders at body level, like the block menu (blocks.ts,
// P1-6): a fixed wrapper inside the scrollback would ride the settle
// glide's transform and stop being viewport-fixed.
//
// Position: anchored below the selection's last client rect, near its end;
// flipped ABOVE the selection when the viewport has no room below (a
// clamped button could sit ON the selection it must never cover, so the
// flip happens before the clamp, not instead of it); then clamped through
// the ONE geometry every floating menu clamps through
// (ui/menu-geometry.ts, nocx-vnirv.2).
import { render } from 'solid-js/web'
import { Button } from './ui/button'
import {
  clampMenuPosition,
  EDGE_MARGIN_PX,
  type MenuSize,
  type ViewportSize,
} from './ui/menu-geometry'

/** The gap between the selection's edge and the button. */
export const SELECTION_GAP_PX = 4

/** The wrapper's identity — the surface's element, placed by the surface. */
const WRAPPER_CLASS = 'attach-affordance'

/** A selection's last client rect, in viewport coordinates. */
export interface AnchorRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface AttachAffordance {
  /** The rendered kit Button — the control a person presses. */
  readonly button: HTMLButtonElement
  /** Whether the button is currently on screen. */
  readonly visible: boolean
  /** Position the button near the end of the selection and show it. A
   *  scroll-follow call is the same call: the surface re-measures the
   *  selection's client rects and re-anchors. */
  show(anchor: AnchorRect, viewport?: ViewportSize): void
  /** Remove the button from the screen. */
  hide(): void
  /** Tear the button down and remove its wrapper. */
  dispose(): void
}

/** The button's on-screen position for a selection end, measured size and
 *  viewport: below the selection's last client rect (right-aligned to its
 *  end), flipped above when there is no room below, then clamped to the
 *  viewport with EDGE_MARGIN_PX to spare. Exported so the geometry is
 *  testable — jsdom measures nothing. */
export function attachButtonPosition(
  anchor: AnchorRect,
  size: MenuSize,
  viewport: ViewportSize,
): { left: number; top: number } {
  let top = anchor.bottom + SELECTION_GAP_PX
  if (top + size.height + EDGE_MARGIN_PX > viewport.height) {
    top = anchor.top - SELECTION_GAP_PX - size.height
  }
  return clampMenuPosition({ x: anchor.right, y: top }, size, viewport)
}

/** Create the affordance: the kit Button rendered into a fixed wrapper
 *  appended to document.body. `onAttach` fires when the button is pressed;
 *  the wrapper's mousedown is prevented so the press never steals the caret
 *  or collapses the selection (nocx-4wtlh). */
export function createAttachAffordance(onAttach: () => void): AttachAffordance {
  const wrapper = document.createElement('div')
  wrapper.className = WRAPPER_CLASS
  // Fixed, inline: viewport coordinates from the selection's client rects
  // map directly, and the contract must hold even where the stylesheet is
  // not loaded (jsdom). The stylesheet keeps the identity and the stacking.
  wrapper.style.position = 'fixed'
  wrapper.style.display = 'none'
  document.body.appendChild(wrapper)
  let dispose: () => void = () => {}
  let shown = false
  dispose = render(
    () => (
      <Button
        variant="primary"
        size="sm"
        ariaLabel="Attach the selection to the next question"
        onClick={() => onAttach()}
      >
        Attach
      </Button>
    ),
    wrapper,
  )
  const button = wrapper.querySelector<HTMLButtonElement>('.ui-button')!
  // A press must never move the caret or collapse the selection: the
  // browser's mousedown default on a button does both. preventDefault keeps
  // the selection and the focus where they are; the click that follows
  // still fires and raises the chip.
  wrapper.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  return {
    get button() {
      return button
    },
    get visible() {
      return shown
    },
    show(
      anchor: AnchorRect,
      viewport: ViewportSize = { width: window.innerWidth, height: window.innerHeight },
    ) {
      // Made visible before measuring: the clamp needs the laid-out size,
      // and the measured size decides the above/below flip. Both happen in
      // this synchronous block, so the position lands before any paint.
      wrapper.style.display = 'block'
      const rect = wrapper.getBoundingClientRect()
      const { left, top } = attachButtonPosition(
        anchor,
        { width: rect.width, height: rect.height },
        viewport,
      )
      wrapper.style.left = `${left}px`
      wrapper.style.top = `${top}px`
      shown = true
    },
    hide() {
      wrapper.style.display = 'none'
      shown = false
    },
    dispose() {
      dispose()
      wrapper.remove()
    },
  }
}
