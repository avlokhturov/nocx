/**
 * ContextMenu — the kit's menu primitive: a small, non-modal popover of
 * actions anchored at a point (the row the user right-clicked). The one
 * vocabulary for "right-click a thing, pick an action" — the README's
 * "Popover/Menu/Combobox: not built" row is this component.
 *
 * What it owns, all in context-menu.css:
 * - the shell: fixed at (x, y), clamped so it never runs off the viewport;
 * - the item list: `ui-context-menu__item` native buttons, one per action;
 * - dismissal: outside pointerdown, Escape, or picking an item;
 * - keyboard: ArrowDown/ArrowUp/Home/End move focus, Enter/Space activate
 *   (native button semantics), and the first item takes focus on open.
 *
 * It is deliberately non-modal and transient: clicking anywhere outside
 * closes it, and there is no focus trap — a menu that blocks the app it
 * floated over is a dialog wearing a menu's clothes. The caller supplies
 * the items (id, label, onSelect) and the anchor point; the component only
 * asks what it needs and never knows what the actions mean.
 *
 * The surface may place the menu (choosing when to open it and where) and
 * may never repaint it — items are the kit's own buttons.
 */
import { For, Show, createEffect, onCleanup, type Component } from 'solid-js'
import { Portal } from 'solid-js/web'

export interface ContextMenuItem {
  /** Stable identity for the item — keying and data-testid. */
  id: string
  label: string
  /**
   * The action's mark, from the kit's icon set. Optional, and a menu may mix
   * rows with and without one: the icon column is reserved either way, so the
   * labels stay in a single column instead of stepping in and out as rows
   * acquire marks. A glyph is the fastest way back to an action a person has
   * used before — they stop reading the menu and start pointing at it — which
   * is exactly what a menu of frequent actions is for.
   *
   * A COMPONENT, NOT AN ELEMENT. An element is DOM the moment it is written,
   * so a row carrying one can only be built where a document exists — and the
   * modules that BUILD rows (workspace-menu.ts) are deliberately pure, tested
   * without a renderer. Naming the component defers the DOM to this file,
   * which is the only place that has one.
   */
  icon?: Component
  onSelect: () => void
}

export interface ContextMenuProps {
  /** Show the menu at (x, y) viewport coordinates. */
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
  /** Called when the menu dismisses itself: outside pointerdown, Escape,
   *  or an item being picked. The caller owns the open state. */
  onClose: () => void
  'data-testid'?: string
}

/** Clearance from the viewport edge when clamping the menu on screen. */
const EDGE_MARGIN_PX = 8

export function ContextMenu(props: ContextMenuProps) {
  let element: HTMLDivElement | undefined

  // Position and focus on open. The anchor does not move while the menu is
  // up, so both are measured once per open — never re-derived per change.
  createEffect(() => {
    if (!props.open) return
    const el = element
    if (!el) return
    // The rect is the laid-out size; the position is clamped so a menu
    // near the bottom or right edge flips inward instead of overflowing.
    const rect = el.getBoundingClientRect()
    const x = Math.min(
      Math.max(props.x, EDGE_MARGIN_PX),
      Math.max(EDGE_MARGIN_PX, window.innerWidth - rect.width - EDGE_MARGIN_PX),
    )
    const y = Math.min(
      Math.max(props.y, EDGE_MARGIN_PX),
      Math.max(EDGE_MARGIN_PX, window.innerHeight - rect.height - EDGE_MARGIN_PX),
    )
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  })

  // Document-level dismissal, attached only while open: an outside
  // pointerdown (the pointer that will click somewhere else) and Escape
  // both close the menu. The item buttons are inside the menu, so their
  // pointerdowns are contained and the subsequent click activates them.
  createEffect(() => {
    if (!props.open) return
    const onPointerDown = (e: PointerEvent): void => {
      const el = element
      if (el && e.target instanceof Node && !el.contains(e.target)) props.onClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
        return
      }
      const items = [...(element?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      if (items.length === 0) return
      const current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const index = current !== null ? items.indexOf(current as HTMLButtonElement) : -1
      let next = -1
      if (e.key === 'ArrowDown') next = index + 1 < items.length ? index + 1 : 0
      else if (e.key === 'ArrowUp') next = index - 1 >= 0 ? index - 1 : items.length - 1
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = items.length - 1
      if (next >= 0) {
        e.preventDefault()
        items[next]?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    })
  })

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="ui-context-menu"
          role="menu"
          data-testid={props['data-testid']}
          ref={(el) => {
            element = el
          }}
        >
          <For each={props.items}>
            {(item) => (
              <button
                type="button"
                class="ui-context-menu__item"
                role="menuitem"
                onClick={() => {
                  props.onClose()
                  item.onSelect()
                }}
              >
                <span class="ui-context-menu__icon" aria-hidden="true">
                  <Show when={item.icon} keyed>
                    {(Icon) => <Icon />}
                  </Show>
                </span>
                <span class="ui-context-menu__label">{item.label}</span>
              </button>
            )}
          </For>
        </div>
      </Portal>
    </Show>
  )
}
