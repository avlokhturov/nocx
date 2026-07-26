// @vitest-environment jsdom

// jsdom does not ship DataTransfer or DragEvent — polyfill for drag-drop tests.
if (typeof DataTransfer === 'undefined') {
  class FakeDataTransfer {
    private store = new Map<string, string>()
    getData(format: string): string {
      return this.store.get(format) ?? ''
    }
    setData(format: string, data: string): void {
      this.store.set(format, data)
    }
    clearData(): void {
      this.store.clear()
    }
  }
  ;(globalThis as Record<string, unknown>).DataTransfer = FakeDataTransfer
}
if (typeof DragEvent === 'undefined') {
  ;(globalThis as Record<string, unknown>).DragEvent = class DragEvent extends MouseEvent {
    readonly dataTransfer: DataTransfer | null
    constructor(type: string, init?: MouseEventInit & { dataTransfer?: DataTransfer }) {
      super(type, init)
      this.dataTransfer = init?.dataTransfer ?? null
    }
  }
}

import { describe, expect, it, beforeEach } from 'vitest'
import { HorizontalTabStrip, VerticalTabStrip, type TabStrip, type TabView } from './tab-strip'

// ═══════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════

let nextId = 1

/** Create a minimal TabView for isolated presentation tests. */
function makeTabView(overrides?: Partial<TabView>): TabView {
  const id = nextId++
  return {
    id,
    title: '',
    hasActivity: false,
    agentStatus: null,
    tooltip: '',
    paneId: `pane-${id}`,
    onDisplayChange: null,
    ...overrides,
  }
}

function mountStrip(): { strip: TabStrip; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.append(container)
  const strip = new HorizontalTabStrip()
  strip.mount(container)
  return { strip, container }
}

/**
 * Fire a keydown event on `target` that bubbles up. Returns the event so
 * callers can assert preventDefault/stopPropagation.
 */
function pressKey(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function mountVerticalStrip(): { strip: TabStrip; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.append(container)
  const strip = new VerticalTabStrip()
  strip.mount(container)
  return { strip, container }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('HorizontalTabStrip', () => {
  beforeEach(() => {
    nextId = 1
    document.body.innerHTML = ''
  })

  // ── Mount ────────────────────────────────────────────────────────────

  it('mounts the tablist, tabs container, add button, and spacer', () => {
    const { container } = mountStrip()
    expect(container.getAttribute('role')).toBe('tablist')
    expect(container.querySelector('.tabs-container')).toBeTruthy()
    const addBtn = container.querySelector('.tab-add') as HTMLElement
    expect(addBtn).toBeTruthy()
    expect(addBtn.getAttribute('aria-label')).toBe('New tab')
    expect(container.querySelector('.tabbar-spacer')).toBeTruthy()
  })

  it('mount is idempotent', () => {
    const { strip, container } = mountStrip()
    // Second mount should not duplicate children.
    strip.mount(container)
    expect(container.querySelectorAll('.tabs-container').length).toBe(1)
  })

  // ── addTab ───────────────────────────────────────────────────────────

  it('addTab creates a tab button with correct structure', () => {
    const { strip, container } = mountStrip()
    const tab = makeTabView({ title: 'hello', tooltip: 'tip' })
    strip.addTab(tab)

    const button = container.querySelector('[role="tab"]') as HTMLElement
    expect(button).toBeTruthy()
    expect(button.getAttribute('aria-controls')).toBe(tab.paneId)
    expect(button.getAttribute('data-tab-id')).toBe(String(tab.id))
    expect(button.draggable).toBe(true)
    expect(button.querySelector('.tab-index')).toBeTruthy()
    expect(button.querySelector('.tab-status')).toBeTruthy()
    expect(button.querySelector('.tab-title')?.textContent).toBe('hello')
    expect(button.querySelector('.tab-close')).toBeTruthy()
    expect(button.querySelector('.tab-indicator')).toBeTruthy()
    expect(button.title).toBe('tip')
  })

  it('addTab sets onDisplayChange so state updates refresh the button', () => {
    const { strip, container } = mountStrip()
    const tab = makeTabView({ title: 'A', hasActivity: false })
    strip.addTab(tab)
    expect(tab.onDisplayChange).not.toBeNull()

    // Mutate the view and notify.
    ;(tab as { title: string }).title = 'B'
    tab.onDisplayChange!()

    const titleSpan = container.querySelector('.tab-title')
    expect(titleSpan?.textContent).toBe('B')
  })

  it('addTab paints activity state', () => {
    const { strip, container } = mountStrip()
    const tab = makeTabView({ hasActivity: true })
    strip.addTab(tab)

    const indicator = container.querySelector('.tab-indicator')
    expect(indicator?.classList.contains('tab-activity')).toBe(true)
  })

  it('addTab paints agent status working', () => {
    const { strip, container } = mountStrip()
    const tab = makeTabView({ agentStatus: 'working' })
    strip.addTab(tab)

    const button = container.querySelector('[role="tab"]')!
    expect(button.classList.contains('working')).toBe(true)
  })

  it('addTab paints agent status idle', () => {
    const { strip, container } = mountStrip()
    const tab = makeTabView({ agentStatus: 'idle' })
    strip.addTab(tab)

    const button = container.querySelector('[role="tab"]')!
    expect(button.classList.contains('waiting')).toBe(true)
  })

  // ── Intents ──────────────────────────────────────────────────────────

  it('emits onActivate when a tab button is clicked', () => {
    const { strip, container } = mountStrip()
    const tab = makeTabView()
    strip.addTab(tab)

    let fired = -1
    strip.onActivate = (id) => {
      fired = id
    }

    const button = container.querySelector('[role="tab"]') as HTMLElement
    button.click()
    expect(fired).toBe(tab.id)
  })

  it('emits onClose when the close button is clicked', () => {
    const { strip, container } = mountStrip()
    const tab = makeTabView()
    strip.addTab(tab)

    let fired = -1
    strip.onClose = (id) => {
      fired = id
    }

    const closeBtn = container.querySelector('.tab-close') as HTMLElement
    closeBtn.click()
    expect(fired).toBe(tab.id)
  })

  it('emits onClose on middle-click', () => {
    const { strip, container } = mountStrip()
    const tab = makeTabView()
    strip.addTab(tab)

    let fired = -1
    strip.onClose = (id) => {
      fired = id
    }

    const button = container.querySelector('[role="tab"]') as HTMLElement
    button.dispatchEvent(new MouseEvent('mousedown', { button: 1 }))
    expect(fired).toBe(tab.id)
  })

  it('emits onNewTab when the add button is clicked', () => {
    const { strip, container } = mountStrip()

    let fired = false
    strip.onNewTab = () => {
      fired = true
    }

    const addBtn = container.querySelector('.tab-add') as HTMLElement
    addBtn.click()
    expect(fired).toBe(true)
  })

  it('emits onReorder on drag-and-drop', () => {
    const { strip, container } = mountStrip()
    const tab1 = makeTabView()
    const tab2 = makeTabView()
    strip.addTab(tab1)
    strip.addTab(tab2)

    let from = -1
    let to = -1
    strip.onReorder = (f, t) => {
      from = f
      to = t
    }

    const button2 = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
    const dt = new DataTransfer()
    dt.setData('text/plain', String(tab1.id))
    button2.dispatchEvent(new DragEvent('drop', { dataTransfer: dt }))

    expect(from).toBe(tab1.id)
    expect(to).toBe(tab2.id)
  })

  // ── setActive ────────────────────────────────────────────────────────

  it('setActive marks the active button and clears others', () => {
    const { strip, container } = mountStrip()
    const t1 = makeTabView()
    const t2 = makeTabView()
    strip.addTab(t1)
    strip.addTab(t2)

    strip.setActive(t1.id)

    const buttons = container.querySelectorAll('[role="tab"]')
    expect(buttons[0].classList.contains('active')).toBe(true)
    expect(buttons[0].getAttribute('aria-selected')).toBe('true')
    expect(buttons[0].getAttribute('tabindex')).toBe('0')

    expect(buttons[1].classList.contains('active')).toBe(false)
    expect(buttons[1].getAttribute('aria-selected')).toBe('false')
    expect(buttons[1].getAttribute('tabindex')).toBe('-1')
  })

  it('setActive clears activity indicator on the activated tab', () => {
    const { strip, container } = mountStrip()
    const tab = makeTabView({ hasActivity: true })
    strip.addTab(tab)

    const indicator = container.querySelector('.tab-indicator')!
    expect(indicator.classList.contains('tab-activity')).toBe(true)

    strip.setActive(tab.id)
    expect(indicator.classList.contains('tab-activity')).toBe(false)
  })

  // ── removeTab ────────────────────────────────────────────────────────

  it('removeTab removes the button from DOM', () => {
    const { strip, container } = mountStrip()
    const tab = makeTabView()
    strip.addTab(tab)
    expect(container.querySelectorAll('[role="tab"]').length).toBe(1)

    strip.removeTab(tab.id)
    expect(container.querySelectorAll('[role="tab"]').length).toBe(0)
  })

  it('removeTab is no-op for unknown id', () => {
    const { strip, container } = mountStrip()
    const tab = makeTabView()
    strip.addTab(tab)
    strip.removeTab(999)
    expect(container.querySelectorAll('[role="tab"]').length).toBe(1)
  })

  // ── reorder ──────────────────────────────────────────────────────────

  it('reorder reorders buttons in DOM', () => {
    const { strip, container } = mountStrip()
    const t1 = makeTabView({ title: 'A' })
    const t2 = makeTabView({ title: 'B' })
    const t3 = makeTabView({ title: 'C' })
    strip.addTab(t1)
    strip.addTab(t2)
    strip.addTab(t3)

    strip.reorder([t3, t1, t2])

    const titles = Array.from(container.querySelectorAll('.tab-title')).map((el) => el.textContent)
    expect(titles).toEqual(['C', 'A', 'B'])
  })

  it('reorder updates index badges', () => {
    const { strip, container } = mountStrip()
    const t1 = makeTabView()
    const t2 = makeTabView()
    const t3 = makeTabView()
    strip.addTab(t1)
    strip.addTab(t2)
    strip.addTab(t3)

    strip.reorder([t3, t1, t2])

    const indices = Array.from(container.querySelectorAll('.tab-index')).map((el) => el.textContent)
    expect(indices).toEqual(['1', '2', '3'])
  })

  // ── Keyboard navigation (roving tabindex) ────────────────────────────

  describe('keyboard', () => {
    it('ArrowRight moves focus to next tab', () => {
      const { strip, container } = mountStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      b1.focus()
      pressKey(b1, 'ArrowRight')

      const b2 = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
      expect(document.activeElement).toBe(b2)
    })

    it('ArrowLeft moves focus to previous tab', () => {
      const { strip, container } = mountStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)

      const b2 = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
      b2.focus()
      pressKey(b2, 'ArrowLeft')

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      expect(document.activeElement).toBe(b1)
    })

    it('ArrowRight wraps from last to first', () => {
      const { strip, container } = mountStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)

      const b2 = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
      b2.focus()
      pressKey(b2, 'ArrowRight')

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      expect(document.activeElement).toBe(b1)
    })

    it('ArrowLeft wraps from first to last', () => {
      const { strip, container } = mountStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      b1.focus()
      pressKey(b1, 'ArrowLeft')

      const b2 = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
      expect(document.activeElement).toBe(b2)
    })

    it('Home moves focus to first tab', () => {
      const { strip, container } = mountStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      const t3 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)
      strip.addTab(t3)

      const b3 = container.querySelectorAll('[role="tab"]')[2] as HTMLElement
      b3.focus()
      pressKey(b3, 'Home')

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      expect(document.activeElement).toBe(b1)
    })

    it('End moves focus to last tab', () => {
      const { strip, container } = mountStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      const t3 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)
      strip.addTab(t3)

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      b1.focus()
      pressKey(b1, 'End')

      const b3 = container.querySelectorAll('[role="tab"]')[2] as HTMLElement
      expect(document.activeElement).toBe(b3)
    })

    it('non-navigation keys are ignored', () => {
      const { strip, container } = mountStrip()
      const tab = makeTabView()
      strip.addTab(tab)

      const b1 = container.querySelector('[role="tab"]') as HTMLElement
      b1.focus()

      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      b1.dispatchEvent(event)

      // Enter should pass through (not prevented).
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(b1)
    })
  })
})

describe('VerticalTabStrip', () => {
  beforeEach(() => {
    nextId = 1
    document.body.innerHTML = ''
  })

  // ── Mount ────────────────────────────────────────────────────────────

  it('mounts the tablist, tabs container, and add button (no spacer)', () => {
    const { container } = mountVerticalStrip()
    expect(container.getAttribute('role')).toBe('tablist')
    expect(container.getAttribute('aria-orientation')).toBe('vertical')
    expect(container.classList.contains('tabstrip-vertical')).toBe(true)
    expect(container.querySelector('.tabs-container')).toBeTruthy()
    const addBtn = container.querySelector('.tab-add') as HTMLElement
    expect(addBtn).toBeTruthy()
    expect(addBtn.getAttribute('aria-label')).toBe('New tab')
    // Vertical strip has no spacer.
    expect(container.querySelector('.tabbar-spacer')).toBeNull()
  })

  it('mount does NOT add the tabbar class', () => {
    // The vertical strip is not the title bar — tabbar carries
    // --wails-draggable: drag and 78px traffic-light padding.
    const { container } = mountVerticalStrip()
    expect(container.classList.contains('tabbar')).toBe(false)
  })

  it('mount is idempotent', () => {
    const { strip, container } = mountVerticalStrip()
    strip.mount(container)
    expect(container.querySelectorAll('.tabs-container').length).toBe(1)
  })

  // ── addTab ───────────────────────────────────────────────────────────

  it('addTab creates a tab button with correct structure', () => {
    const { strip, container } = mountVerticalStrip()
    const tab = makeTabView({ title: 'hello', tooltip: 'tip' })
    strip.addTab(tab)

    const button = container.querySelector('[role="tab"]') as HTMLElement
    expect(button).toBeTruthy()
    expect(button.getAttribute('aria-controls')).toBe(tab.paneId)
    expect(button.getAttribute('data-tab-id')).toBe(String(tab.id))
    expect(button.draggable).toBe(true)
    expect(button.querySelector('.tab-index')).toBeTruthy()
    expect(button.querySelector('.tab-status')).toBeTruthy()
    expect(button.querySelector('.tab-title')?.textContent).toBe('hello')
    expect(button.querySelector('.tab-close')).toBeTruthy()
    expect(button.querySelector('.tab-indicator')).toBeTruthy()
    expect(button.title).toBe('tip')
  })

  it('addTab sets onDisplayChange so state updates refresh the button', () => {
    const { strip, container } = mountVerticalStrip()
    const tab = makeTabView({ title: 'A', hasActivity: false })
    strip.addTab(tab)
    expect(tab.onDisplayChange).not.toBeNull()

    ;(tab as { title: string }).title = 'B'
    tab.onDisplayChange!()

    const titleSpan = container.querySelector('.tab-title')
    expect(titleSpan?.textContent).toBe('B')
  })

  it('addTab paints activity state', () => {
    const { strip, container } = mountVerticalStrip()
    const tab = makeTabView({ hasActivity: true })
    strip.addTab(tab)

    const indicator = container.querySelector('.tab-indicator')
    expect(indicator?.classList.contains('tab-activity')).toBe(true)
  })

  it('addTab paints agent status working', () => {
    const { strip, container } = mountVerticalStrip()
    const tab = makeTabView({ agentStatus: 'working' })
    strip.addTab(tab)

    const button = container.querySelector('[role="tab"]')!
    expect(button.classList.contains('working')).toBe(true)
  })

  it('addTab paints agent status idle', () => {
    const { strip, container } = mountVerticalStrip()
    const tab = makeTabView({ agentStatus: 'idle' })
    strip.addTab(tab)

    const button = container.querySelector('[role="tab"]')!
    expect(button.classList.contains('waiting')).toBe(true)
  })

  // ── Intents ──────────────────────────────────────────────────────────

  it('emits onActivate when a tab button is clicked', () => {
    const { strip, container } = mountVerticalStrip()
    const tab = makeTabView()
    strip.addTab(tab)

    let fired = -1
    strip.onActivate = (id) => {
      fired = id
    }

    const button = container.querySelector('[role="tab"]') as HTMLElement
    button.click()
    expect(fired).toBe(tab.id)
  })

  it('emits onClose when the close button is clicked', () => {
    const { strip, container } = mountVerticalStrip()
    const tab = makeTabView()
    strip.addTab(tab)

    let fired = -1
    strip.onClose = (id) => {
      fired = id
    }

    const closeBtn = container.querySelector('.tab-close') as HTMLElement
    closeBtn.click()
    expect(fired).toBe(tab.id)
  })

  it('emits onClose on middle-click', () => {
    const { strip, container } = mountVerticalStrip()
    const tab = makeTabView()
    strip.addTab(tab)

    let fired = -1
    strip.onClose = (id) => {
      fired = id
    }

    const button = container.querySelector('[role="tab"]') as HTMLElement
    button.dispatchEvent(new MouseEvent('mousedown', { button: 1 }))
    expect(fired).toBe(tab.id)
  })

  it('emits onNewTab when the add button is clicked', () => {
    const { strip, container } = mountVerticalStrip()

    let fired = false
    strip.onNewTab = () => {
      fired = true
    }

    const addBtn = container.querySelector('.tab-add') as HTMLElement
    addBtn.click()
    expect(fired).toBe(true)
  })

  it('emits onReorder on drag-and-drop', () => {
    const { strip, container } = mountVerticalStrip()
    const tab1 = makeTabView()
    const tab2 = makeTabView()
    strip.addTab(tab1)
    strip.addTab(tab2)

    let from = -1
    let to = -1
    strip.onReorder = (f, t) => {
      from = f
      to = t
    }

    const button2 = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
    const dt = new DataTransfer()
    dt.setData('text/plain', String(tab1.id))
    button2.dispatchEvent(new DragEvent('drop', { dataTransfer: dt }))

    expect(from).toBe(tab1.id)
    expect(to).toBe(tab2.id)
  })

  // ── setActive ────────────────────────────────────────────────────────

  it('setActive marks the active button and clears others', () => {
    const { strip, container } = mountVerticalStrip()
    const t1 = makeTabView()
    const t2 = makeTabView()
    strip.addTab(t1)
    strip.addTab(t2)

    strip.setActive(t1.id)

    const buttons = container.querySelectorAll('[role="tab"]')
    expect(buttons[0].classList.contains('active')).toBe(true)
    expect(buttons[0].getAttribute('aria-selected')).toBe('true')
    expect(buttons[0].getAttribute('tabindex')).toBe('0')

    expect(buttons[1].classList.contains('active')).toBe(false)
    expect(buttons[1].getAttribute('aria-selected')).toBe('false')
    expect(buttons[1].getAttribute('tabindex')).toBe('-1')
  })

  it('setActive clears activity indicator on the activated tab', () => {
    const { strip, container } = mountVerticalStrip()
    const tab = makeTabView({ hasActivity: true })
    strip.addTab(tab)

    const indicator = container.querySelector('.tab-indicator')!
    expect(indicator.classList.contains('tab-activity')).toBe(true)

    strip.setActive(tab.id)
    expect(indicator.classList.contains('tab-activity')).toBe(false)
  })

  // ── removeTab ────────────────────────────────────────────────────────

  it('removeTab removes the button from DOM', () => {
    const { strip, container } = mountVerticalStrip()
    const tab = makeTabView()
    strip.addTab(tab)
    expect(container.querySelectorAll('[role="tab"]').length).toBe(1)

    strip.removeTab(tab.id)
    expect(container.querySelectorAll('[role="tab"]').length).toBe(0)
  })

  it('removeTab is no-op for unknown id', () => {
    const { strip, container } = mountVerticalStrip()
    const tab = makeTabView()
    strip.addTab(tab)
    strip.removeTab(999)
    expect(container.querySelectorAll('[role="tab"]').length).toBe(1)
  })

  // ── reorder ──────────────────────────────────────────────────────────

  it('reorder reorders buttons in DOM', () => {
    const { strip, container } = mountVerticalStrip()
    const t1 = makeTabView({ title: 'A' })
    const t2 = makeTabView({ title: 'B' })
    const t3 = makeTabView({ title: 'C' })
    strip.addTab(t1)
    strip.addTab(t2)
    strip.addTab(t3)

    strip.reorder([t3, t1, t2])

    const titles = Array.from(container.querySelectorAll('.tab-title')).map((el) => el.textContent)
    expect(titles).toEqual(['C', 'A', 'B'])
  })

  it('reorder updates index badges', () => {
    const { strip, container } = mountVerticalStrip()
    const t1 = makeTabView()
    const t2 = makeTabView()
    const t3 = makeTabView()
    strip.addTab(t1)
    strip.addTab(t2)
    strip.addTab(t3)

    strip.reorder([t3, t1, t2])

    const indices = Array.from(container.querySelectorAll('.tab-index')).map((el) => el.textContent)
    expect(indices).toEqual(['1', '2', '3'])
  })

  // ── Keyboard navigation (roving tabindex) ────────────────────────────

  describe('keyboard', () => {
    it('ArrowDown moves focus to next tab', () => {
      const { strip, container } = mountVerticalStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      b1.focus()
      pressKey(b1, 'ArrowDown')

      const b2 = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
      expect(document.activeElement).toBe(b2)
    })

    it('ArrowUp moves focus to previous tab', () => {
      const { strip, container } = mountVerticalStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)

      const b2 = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
      b2.focus()
      pressKey(b2, 'ArrowUp')

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      expect(document.activeElement).toBe(b1)
    })

    it('ArrowDown wraps from last to first', () => {
      const { strip, container } = mountVerticalStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)

      const b2 = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
      b2.focus()
      pressKey(b2, 'ArrowDown')

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      expect(document.activeElement).toBe(b1)
    })

    it('ArrowUp wraps from first to last', () => {
      const { strip, container } = mountVerticalStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      b1.focus()
      pressKey(b1, 'ArrowUp')

      const b2 = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
      expect(document.activeElement).toBe(b2)
    })

    it('Home moves focus to first tab', () => {
      const { strip, container } = mountVerticalStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      const t3 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)
      strip.addTab(t3)

      const b3 = container.querySelectorAll('[role="tab"]')[2] as HTMLElement
      b3.focus()
      pressKey(b3, 'Home')

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      expect(document.activeElement).toBe(b1)
    })

    it('End moves focus to last tab', () => {
      const { strip, container } = mountVerticalStrip()
      const t1 = makeTabView()
      const t2 = makeTabView()
      const t3 = makeTabView()
      strip.addTab(t1)
      strip.addTab(t2)
      strip.addTab(t3)

      const b1 = container.querySelectorAll('[role="tab"]')[0] as HTMLElement
      b1.focus()
      pressKey(b1, 'End')

      const b3 = container.querySelectorAll('[role="tab"]')[2] as HTMLElement
      expect(document.activeElement).toBe(b3)
    })

    it('non-navigation keys are ignored', () => {
      const { strip, container } = mountVerticalStrip()
      const tab = makeTabView()
      strip.addTab(tab)

      const b1 = container.querySelector('[role="tab"]') as HTMLElement
      b1.focus()

      // Horizontal navigation keys should NOT be handled by the vertical strip.
      const eventRight = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      })
      b1.dispatchEvent(eventRight)
      expect(eventRight.defaultPrevented).toBe(false)

      const eventLeft = new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
        cancelable: true,
      })
      b1.dispatchEvent(eventLeft)
      expect(eventLeft.defaultPrevented).toBe(false)

      // Enter should pass through.
      const eventEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
      b1.dispatchEvent(eventEnter)
      expect(eventEnter.defaultPrevented).toBe(false)

      expect(document.activeElement).toBe(b1)
    })
  })
})
