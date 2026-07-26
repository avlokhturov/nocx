import type { AgentStatus } from './agent-status'

// ═══════════════════════════════════════════════════════════════════════════
// TabStrip — presentation port for tab chrome
// ═══════════════════════════════════════════════════════════════════════════
//
// TabManager owns the tab model and activation rules. TabStrip owns the
// chrome: creating, placing, styling tab buttons and emitting user intents.
// Neither knows about the other's internals.
//
// The port is designed so that a vertical TabStrip implementation can be
// plugged in later without reopening TabManager or Tab — it only needs to
// satisfy this interface and handle Up/Down instead of Left/Right.
//
// TabStrip never imports Tab. It reads display state through TabView, a
// minimal contract that Tab satisfies structurally.

/** The display state a TabStrip reads from each tab. */
export interface TabView {
  readonly id: number
  readonly title: string
  readonly hasActivity: boolean
  readonly agentStatus: AgentStatus | null
  readonly tooltip: string
  /** The tabpanel element id, used for aria-controls. */
  readonly paneId: string
  /**
   * Set by the TabStrip on addTab. The model calls this whenever display
   * state changes (title, activity, agent status, tooltip). The TabStrip
   * re-reads the TabView properties and updates the button DOM.
   */
  onDisplayChange: (() => void) | null
}

/**
 * Presentation port for tab chrome. Implementations own the DOM for tab
 * buttons and emit structured intents that TabManager consumes.
 */
export interface TabStrip {
  /** Mount the strip into a container element. Creates internal chrome
   *  (tabs container, add button, spacer). Idempotent — safe to call once. */
  mount(container: HTMLElement): void

  /** Add a tab button. Reads initial display state from `tab`.
   *  Sets `tab.onDisplayChange` to refresh the button on state changes. */
  addTab(tab: TabView): void

  /** Remove the tab button for `tabId`. No-op if not found. */
  removeTab(tabId: number): void

  /** Mark the tab as active. Updates button styling and roving tabindex. */
  setActive(tabId: number): void

  /** Reorder buttons to match the given tab order. */
  reorder(tabs: readonly TabView[]): void

  // ── Intents (set by TabManager) ──────────────────────────────────────

  /** User clicked a tab button. */
  onActivate: ((tabId: number) => void) | null
  /** User clicked the close button or middle-clicked a tab. */
  onClose: ((tabId: number) => void) | null
  /** User clicked the new-tab button. */
  onNewTab: (() => void) | null
  /** User dragged a tab to a new position. */
  onReorder: ((fromId: number, toId: number) => void) | null
}

// ═══════════════════════════════════════════════════════════════════════════
// HorizontalTabStrip
// ═══════════════════════════════════════════════════════════════════════════

export class HorizontalTabStrip implements TabStrip {
  private container: HTMLElement | null = null
  private readonly buttons = new Map<number, HTMLElement>()
  /** Stored so onDisplayChange can be cleared on remove. */
  private readonly views = new Map<number, TabView>()
  private mounted = false

  // Intent callbacks
  onActivate: ((tabId: number) => void) | null = null
  onClose: ((tabId: number) => void) | null = null
  onNewTab: (() => void) | null = null
  onReorder: ((fromId: number, toId: number) => void) | null = null

  mount(container: HTMLElement): void {
    if (this.mounted) return
    this.mounted = true

    this.container = container
    container.setAttribute('role', 'tablist')
    container.setAttribute('aria-label', 'Tabs')
    container.classList.add('tabbar')

    // Container for tab buttons — non-growing flex child.
    const tabsContainer = document.createElement('div')
    tabsContainer.className = 'tabs-container'
    container.append(tabsContainer)

    // New-tab button
    const addBtn = document.createElement('button')
    addBtn.className = 'tab-add'
    addBtn.textContent = '+'
    addBtn.setAttribute('aria-label', 'New tab')
    addBtn.addEventListener('click', () => this.onNewTab?.())
    container.append(addBtn)

    // Flexible spacer absorbs leftover width.
    const spacer = document.createElement('div')
    spacer.className = 'tabbar-spacer'
    container.append(spacer)

    // Keyboard navigation on the tablist (roving tabindex).
    container.addEventListener('keydown', this.onTablistKeydown)
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
    // Roving tabindex: only the active tab gets tabindex=0; all others get -1.
    button.tabIndex = -1

    // ── Index badge ────────────────────────────────────────────────────
    const indexLabel = document.createElement('span')
    indexLabel.className = 'tab-index'
    button.append(indexLabel)

    // ── Status icon + title (travelling together as one centred unit) ───
    const label = document.createElement('span')
    label.className = 'tab-label'

    const statusIcon = document.createElement('span')
    statusIcon.className = 'tab-status'
    const titleSpan = document.createElement('span')
    titleSpan.className = 'tab-title'
    label.append(statusIcon, titleSpan)
    button.append(label)

    // ── Close button ───────────────────────────────────────────────────
    const closeBtn = document.createElement('button')
    closeBtn.className = 'tab-close'
    closeBtn.textContent = '\u00d7'
    closeBtn.setAttribute('aria-label', 'Close tab')
    button.append(closeBtn)

    // ── Indicator bar ──────────────────────────────────────────────────
    const indicator = document.createElement('div')
    indicator.className = 'tab-indicator'
    button.append(indicator)

    // ── Paint initial state ────────────────────────────────────────────
    this.paintButton(button, tab)

    // ── Event wiring ───────────────────────────────────────────────────
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

    // ── Subscribe to state changes ─────────────────────────────────────
    tab.onDisplayChange = () => this.paintButton(button, tab)

    // ── Insert into DOM ────────────────────────────────────────────────
    const tabsContainer = this.container.querySelector('.tabs-container')
    tabsContainer?.append(button)
    this.buttons.set(tab.id, button)
    this.views.set(tab.id, tab)
    // (TabManager appends it before calling addTab).
    const pane = document.getElementById(tab.paneId)
    if (pane) pane.setAttribute('aria-labelledby', button.id)

    this.refreshIndicesFromDOM()
  }

  removeTab(tabId: number): void {
    const button = this.buttons.get(tabId)
    if (button) {
      button.remove()
      this.buttons.delete(tabId)
      const view = this.views.get(tabId)
      if (view) view.onDisplayChange = null
      this.views.delete(tabId)
      this.refreshIndicesFromDOM()
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
    // Repaint after toggling .active so the newly-inactive tab's pending
    // activity indicator shows — paintButton gates on !.active, which was
    // still set during the setActive(false)-triggered repaint earlier in
    // activate().  Without this repaint, the indicator stays hidden and a
    // later bell (or other attention event) finds _hasActivity already true
    // and never reaches onDisplayChange either.
    for (const [id, tab] of this.views) {
      const button = this.buttons.get(id)
      if (button) this.paintButton(button, tab)
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
    this.refreshIndicesFromDOM()
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /** Paint a button from the current TabView state. */
  private paintButton(button: HTMLElement, tab: TabView): void {
    const titleSpan = button.querySelector('.tab-title')
    if (titleSpan) titleSpan.textContent = tab.title

    button.title = tab.tooltip

    const statusIcon = button.querySelector('.tab-status')
    if (statusIcon) {
      button.classList.toggle('working', tab.agentStatus === 'working')
      button.classList.toggle('waiting', tab.agentStatus === 'idle')
    }

    const indicator = button.querySelector('.tab-indicator')
    if (indicator) {
      indicator.classList.toggle(
        'tab-activity',
        tab.hasActivity && !button.classList.contains('active'),
      )
    }
  }

  /** Update index badges from DOM order (self-healing on add/remove/reorder). */
  private refreshIndicesFromDOM(): void {
    const buttons = this.orderedButtons()
    buttons.forEach((button, i) => {
      const indexLabel = button.querySelector('.tab-index')
      if (indexLabel) indexLabel.textContent = String(i + 1)
    })
  }

  // ── Keyboard (roving tabindex) ───────────────────────────────────────

  private readonly onTablistKeydown = (e: KeyboardEvent): void => {
    // Only handle keys that navigate within the tablist.
    const key = e.key
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return

    const button = (e.target as HTMLElement).closest('[role="tab"]')
    if (!button) return

    e.preventDefault()
    e.stopPropagation()

    const ordered = this.orderedButtons()
    const idx = ordered.indexOf(button as HTMLElement)
    if (idx === -1) return

    let nextIdx: number
    switch (key) {
      case 'ArrowLeft':
        nextIdx = idx > 0 ? idx - 1 : ordered.length - 1
        break
      case 'ArrowRight':
        nextIdx = idx < ordered.length - 1 ? idx + 1 : 0
        break
      case 'Home':
        nextIdx = 0
        break
      case 'End':
        nextIdx = ordered.length - 1
        break
      default:
        return
    }

    const nextButton = ordered[nextIdx]
    nextButton.focus()
  }

  /** Return tab buttons in DOM order. */
  private orderedButtons(): HTMLElement[] {
    const tabsContainer = this.container?.querySelector('.tabs-container')
    if (!tabsContainer) return []
    return Array.from(tabsContainer.querySelectorAll('[role="tab"]'))
  }
}
