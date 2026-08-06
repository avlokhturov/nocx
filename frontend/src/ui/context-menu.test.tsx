// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { Show, createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, type ContextMenuItem } from './context-menu'

// The menu PORTALS into document.body (the kit's portal root), so the
// queries target the document, never render()'s container.

afterEach(cleanup)

const ITEMS: ContextMenuItem[] = [
  { id: 'copy', label: 'Copy path', onSelect: () => undefined },
  { id: 'reveal', label: 'Show in Finder', onSelect: () => undefined },
]

function items(over: Partial<Record<'copy' | 'reveal', ContextMenuItem>> = {}): ContextMenuItem[] {
  return ITEMS.map((item) => ({ ...item, ...over[item.id as 'copy' | 'reveal'] }))
}

function menu(): HTMLElement | null {
  return document.querySelector('.ui-context-menu')
}

function menuItems(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
}

describe('ContextMenu', () => {
  it('renders nothing while closed and the items as menuitems when open', () => {
    const closed = render(() => (
      <ContextMenu open={false} x={10} y={20} items={ITEMS} onClose={() => undefined} />
    ))
    expect(menu()).toBeNull()
    closed.unmount()

    render(() => <ContextMenu open x={10} y={20} items={ITEMS} onClose={() => undefined} />)
    expect(menu()?.getAttribute('role')).toBe('menu')
    expect(menuItems().map((i) => i.textContent)).toEqual(['Copy path', 'Show in Finder'])
  })

  it('positions the shell at the anchor and clamps it to the viewport', () => {
    render(() => <ContextMenu open x={1000} y={2000} items={ITEMS} onClose={() => undefined} />)
    const el = menu()
    expect(el).not.toBeNull()
    // jsdom's viewport is 1024x768; the anchor is beyond it, so the shell
    // must be pulled back inside instead of overflowing.
    const x = Number.parseInt(el!.style.left, 10)
    const y = Number.parseInt(el!.style.top, 10)
    expect(x).toBeLessThanOrEqual(window.innerWidth - 8)
    expect(y).toBeLessThanOrEqual(window.innerHeight - 8)
  })

  it('gives the first item focus on open', () => {
    render(() => <ContextMenu open x={10} y={20} items={ITEMS} onClose={() => undefined} />)
    expect(document.activeElement).toBe(menuItems()[0])
  })

  it('activates an item through its button and dismisses the menu', () => {
    const onCopy = vi.fn()
    const close = vi.fn()
    render(() => (
      <ContextMenu
        open
        x={10}
        y={20}
        items={items({ copy: { id: 'copy', label: 'Copy path', onSelect: onCopy } })}
        onClose={close}
      />
    ))
    fireEvent.click(menuItems()[0])
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes on an outside pointerdown and not on one inside the menu', () => {
    const close = vi.fn()
    render(() => <ContextMenu open x={10} y={20} items={ITEMS} onClose={close} />)
    fireEvent.pointerDown(menuItems()[0])
    expect(close).not.toHaveBeenCalled()

    fireEvent.pointerDown(document.body)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    const close = vi.fn()
    render(() => <ContextMenu open x={10} y={20} items={ITEMS} onClose={close} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('walks the items with the arrow keys, Home and End', () => {
    render(() => <ContextMenu open x={10} y={20} items={ITEMS} onClose={() => undefined} />)
    fireEvent.keyDown(menuItems()[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(menuItems()[1])
    fireEvent.keyDown(menuItems()[1], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(menuItems()[0])
    fireEvent.keyDown(menuItems()[0], { key: 'End' })
    expect(document.activeElement).toBe(menuItems()[1])
    fireEvent.keyDown(menuItems()[1], { key: 'Home' })
    expect(document.activeElement).toBe(menuItems()[0])
  })

  it('stops listening when closed', () => {
    const close = vi.fn()
    const [open, setOpen] = createSignal(true)
    render(() => (
      <Show when={open()} fallback={null}>
        <ContextMenu open items={ITEMS} x={10} y={20} onClose={close} />
      </Show>
    ))
    setOpen(false)
    fireEvent.pointerDown(document.body)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
  })
})
