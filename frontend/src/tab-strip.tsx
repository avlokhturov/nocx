import { Show } from 'solid-js'
import { render } from 'solid-js/web'
import type { AgentStatus } from './agent-status'

// ═══════════════════════════════════════════════════════════════════════════
// TabStrip — presentation port for tab chrome
// ═══════════════════════════════════════════════════════════════════════════

/** The display state a TabStrip reads from each tab. */
export interface TabView {
  readonly id: number
  readonly title: string
  readonly hasActivity: boolean
  readonly agentStatus: AgentStatus | null
  readonly tooltip: string
  readonly paneId: string
  onDisplayChange: (() => void) | null
}

/** Presentation port for tab chrome. */
export interface TabStrip {
  readonly orientation: Orientation
  mount(container: HTMLElement): void
  addTab(tab: TabView): void
  removeTab(tabId: number): void
  setActive(tabId: number): void
  reorder(tabs: readonly TabView[]): void

  onActivate: ((tabId: number) => void) | null
  onClose: ((tabId: number) => void) | null
  onNewTab: (() => void) | null
  onReorder: ((fromId: number, toId: number) => void) | null
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal types
// ═══════════════════════════════════════════════════════════════════════════

export type Orientation = 'horizontal' | 'vertical'

// ═══════════════════════════════════════════════════════════════════════════
// Adapter base — Solid renders the static wrapping structure; tab buttons
// are created, updated, and destroyed imperatively for full backward
// compatibility with existing DOM-level tests and e2e MutationObservers.
// ═══════════════════════════════════════════════════════════════════════════

abstract class TabStripBase implements TabStrip {
  protected dispose: (() => void) | null = null
  protected container: HTMLElement | null = null
  private mounted = false
  /** Tab buttons by id, for imperative display updates. */
  private readonly buttons = new Map<number, HTMLElement>()
  /** Stored so onDisplayChange can be cleared on remove. */
  private readonly views = new Map<number, TabView>()

  public abstract readonly orientation: Orientation

  // Intent callbacks
  onActivate: ((tabId: number) => void) | null = null
  onClose: ((tabId: number) => void) | null = null
  onNewTab: (() => void) | null = null
  onReorder: ((fromId: number, toId: number) => void) | null = null

  /** Subclasses set up container attributes (class, aria). */
  protected abstract setupContainer(container: HTMLElement): void

  mount(container: HTMLElement): void {
    if (this.mounted) return
    this.mounted = true
    this.container = container

    this.setupContainer(container)
    container.addEventListener('keydown', this.onTablistKeydown)

    // Solid renders the static structure (tabs-container, add button, spacer).
    // The tabs-container is initially empty — tab buttons are added imperatively.
    // Arrow function in render() captures `this` from the enclosing mount method.
    this.dispose = render(
      () => (
        <>
          <div class="tabs-container" />
          <button class="tab-add" aria-label="New tab" onClick={() => this.onNewTab?.()}>
            +
          </button>
          <Show when={this.orientation === 'horizontal'}>
            <div class="tabbar-spacer" />
          </Show>
        </>
      ),
      container,
    )
  }

  addTab(tab: TabView): void {
    if (!this.container) return

    const button = document.createElement('div')
    button.id = `tab-btn-${tab.id}`
    button.className = 'tab'
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-controls', tab.paneId)
    button.setAttribute('data-tab-id', String(tab.id))
    button.draggable = true
    // Roving tabindex: only the active tab gets tabindex=0.
    button.tabIndex = -1

    // Index badge
    const indexLabel = document.createElement('span')
    indexLabel.className = 'tab-index'
    button.append(indexLabel)

    // Status icon + title
    const label = document.createElement('span')
    label.className = 'tab-label'
    const statusIcon = document.createElement('span')
    statusIcon.className = 'tab-status'
    const titleSpan = document.createElement('span')
    titleSpan.className = 'tab-title'
    label.append(statusIcon, titleSpan)
    button.append(label)

    // Close button
    const closeBtn = document.createElement('button')
    closeBtn.className = 'tab-close'
    closeBtn.textContent = '\u00d7'
    closeBtn.setAttribute('aria-label', 'Close tab')
    button.append(closeBtn)

    // Indicator bar
    const indicator = document.createElement('div')
    indicator.className = 'tab-indicator'
    button.append(indicator)

    // Paint initial state
    this.paintButton(button, tab)

    // Event wiring
    button.addEventListener('click', () => this.onActivate?.(tab.id))
    closeBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation()
      this.onClose?.(tab.id)
    })
    button.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        this.onClose?.(tab.id)
      }
    })

    // Drag-and-drop reorder
    button.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer?.setData('text/plain', String(tab.id))
      button.classList.add('dragging')
    })
    button.addEventListener('dragend', () => {
      button.classList.remove('dragging')
    })
    button.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault()
    })
    button.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault()
      const draggedId = Number(e.dataTransfer?.getData('text/plain'))
      if (!Number.isNaN(draggedId) && draggedId !== tab.id) {
        this.onReorder?.(draggedId, tab.id)
      }
    })

    // Subscribe to state changes
    tab.onDisplayChange = () => this.paintButton(button, tab)

    // Insert into DOM
    const tabsContainer = this.container.querySelector('.tabs-container')
    tabsContainer?.append(button)
    this.buttons.set(tab.id, button)
    this.views.set(tab.id, tab)

    // Link pane to button (aria-labelledby)
    const pane = document.getElementById(tab.paneId)
    if (pane) pane.setAttribute('aria-labelledby', button.id)

    this.refreshIndices()
  }

  removeTab(tabId: number): void {
    const button = this.buttons.get(tabId)
    if (button) {
      button.remove()
      this.buttons.delete(tabId)
      const view = this.views.get(tabId)
      if (view) view.onDisplayChange = null
      this.views.delete(tabId)
      this.refreshIndices()
    }
  }

  setActive(tabId: number): void {
    // Update roving tabindex: active gets 0, all others get -1.
    for (const [id, button] of this.buttons) {
      const active = id === tabId
      button.classList.toggle('active', active)
      button.setAttribute('aria-selected', String(active))
      button.tabIndex = active ? 0 : -1
    }
    // Re-paint for activity indicators: paintButton gates on !.active, which
    // was still set during the setActive(false)-triggered repaint earlier in
    // activate(). Without this repaint, a newly-inactive tab's pending activity
    // indicator stays hidden.
    for (const [id, tab] of this.views) {
      const btn = this.buttons.get(id)
      if (btn) this.paintButton(btn, tab)
    }
  }

  reorder(tabs: readonly TabView[]): void {
    const tabsContainer = this.container?.querySelector('.tabs-container')
    if (!tabsContainer) return
    tabsContainer.innerHTML = ''
    for (const tab of tabs) {
      const button = this.buttons.get(tab.id)
      if (button) tabsContainer.append(button)
    }
    this.refreshIndices()
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private paintButton(button: HTMLElement, tab: TabView): void {
    const titleSpan = button.querySelector('.tab-title')
    if (titleSpan) titleSpan.textContent = tab.title

    button.title = tab.tooltip

    button.classList.toggle('working', tab.agentStatus === 'working')
    button.classList.toggle('waiting', tab.agentStatus === 'idle')

    const indicator = button.querySelector('.tab-indicator')
    if (indicator) {
      indicator.classList.toggle(
        'tab-activity',
        tab.hasActivity && !button.classList.contains('active'),
      )
    }
  }

  /** Update index badges from DOM order. */
  private refreshIndices(): void {
    const ordered = this.orderedButtons()
    ordered.forEach((btn, i) => {
      const label = btn.querySelector('.tab-index')
      if (label) label.textContent = String(i + 1)
    })
  }

  /** Return tab buttons in DOM order. */
  private orderedButtons(): HTMLElement[] {
    const tabsContainer = this.container?.querySelector('.tabs-container')
    if (!tabsContainer) return []
    return Array.from(tabsContainer.querySelectorAll('[role="tab"]'))
  }

  // ── Keyboard (roving tabindex) ───────────────────────────────────────

  private readonly onTablistKeydown = (e: KeyboardEvent): void => {
    const keys =
      this.orientation === 'vertical'
        ? ['ArrowUp', 'ArrowDown', 'Home', 'End']
        : ['ArrowLeft', 'ArrowRight', 'Home', 'End']
    if (!keys.includes(e.key)) return

    const button = (e.target as HTMLElement).closest('[role="tab"]')
    if (!button) return

    e.preventDefault()
    e.stopPropagation()

    const ordered = this.orderedButtons()
    const idx = ordered.indexOf(button as HTMLElement)
    if (idx === -1) return

    let nextIdx: number
    const len = ordered.length
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowLeft':
        nextIdx = idx > 0 ? idx - 1 : len - 1
        break
      case 'ArrowDown':
      case 'ArrowRight':
        nextIdx = idx < len - 1 ? idx + 1 : 0
        break
      case 'Home':
        nextIdx = 0
        break
      case 'End':
        nextIdx = len - 1
        break
      default:
        return
    }
    ordered[nextIdx]?.focus()
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HorizontalTabStrip
// ═══════════════════════════════════════════════════════════════════════════

export class HorizontalTabStrip extends TabStripBase {
  public readonly orientation: Orientation = 'horizontal'

  protected setupContainer(container: HTMLElement): void {
    container.setAttribute('role', 'tablist')
    container.setAttribute('aria-label', 'Tabs')
    container.classList.add('tabbar')
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VerticalTabStrip
// ═══════════════════════════════════════════════════════════════════════════

export class VerticalTabStrip extends TabStripBase {
  public readonly orientation: Orientation = 'vertical'

  protected setupContainer(container: HTMLElement): void {
    container.setAttribute('role', 'tablist')
    container.setAttribute('aria-label', 'Tabs')
    container.setAttribute('aria-orientation', 'vertical')
    container.classList.add('tabstrip-vertical')
  }
}
