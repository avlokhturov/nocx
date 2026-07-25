/**
 * App-shell sidebar — VS Code style: a permanent narrow activity bar on the
 * far left plus a wide panel next to it that collapses. Clicking the active
 * view's icon collapses the panel; clicking any icon while collapsed opens
 * the panel on that view. Ctrl/Cmd+B toggles, as in VS Code.
 *
 * The panel is deliberately empty of real content for now: it exists as the
 * region future homes (SSH hosts, vault, saved sessions, settings) plug into
 * (nocx-8yg.9), so the shell layout never has to be restructured for them.
 */

/** A view the activity bar can show. */
export interface SidebarView {
  readonly id: string
  readonly title: string
  /** Inline SVG markup for the activity-bar icon. */
  readonly icon: string
  /** Action type: 'panel' shows content in sidebar, 'tab' opens a full-screen tab. */
  readonly action: 'panel' | 'tab'
  /** For 'panel': mount function called when view becomes active. */
  readonly mount?: (panel: HTMLElement) => void
  /** For 'tab': callback when button is clicked. */
  readonly onActivate?: () => void
}

export interface Sidebar {
  /** True when the wide panel is hidden. The activity bar never hides. */
  readonly collapsed: boolean
  /** The selected view — retained while collapsed, so re-opening restores it. */
  readonly activeViewId: string | null
  toggle(): void
}

const STORAGE_KEY = 'nocx.sidebar.collapsed'

/** Minimal storage surface the sidebar needs — injectable so tests do not
 *  depend on jsdom's localStorage quirks and a Wails webview can substitute
 *  its own persistence later. */
export interface SidebarStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export class SidebarImpl implements Sidebar {
  private _collapsed: boolean
  private _activeViewId: string
  private readonly _views = new Map<string, SidebarView>()
  private readonly _buttons = new Map<string, HTMLElement>()
  private readonly _contentContainers = new Map<string, HTMLElement>()
  private readonly _title: HTMLElement
  private _currentContent: HTMLElement | null = null

  constructor(
    bar: HTMLElement,
    private readonly _panel: HTMLElement,
    views: readonly SidebarView[],
    private readonly _storage: SidebarStorage | null = safeLocalStorage(),
  ) {
    if (views.length === 0) throw new Error('Sidebar needs at least one view')
    this._activeViewId = views[0].id
    this._collapsed = this._storage?.getItem(STORAGE_KEY) === '1'

    for (const view of views) {
      this._views.set(view.id, view)
      const btn = document.createElement('button')
      btn.className = 'activity-bar-btn'
      btn.dataset.view = view.id
      btn.title = view.title
      btn.setAttribute('aria-label', view.title)
      btn.innerHTML = view.icon
      btn.addEventListener('click', () => this._handleClick(view))
      bar.append(btn)
      this._buttons.set(view.id, btn)

      // For 'panel' views: create content container and mount
      if (view.action === 'panel' && view.mount) {
        const container = document.createElement('div')
        container.className = 'sidebar-content'
        container.dataset.view = view.id
        container.style.display = 'none'
        this._panel.append(container)
        this._contentContainers.set(view.id, container)
        view.mount(container)
      }
    }

    this._title = document.createElement('div')
    this._title.className = 'sidebar-title'
    this._panel.prepend(this._title)

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === 'b') {
        this.toggle()
      }
    })

    this._render()
  }

  private _handleClick(view: SidebarView): void {
    if (view.action === 'tab') {
      // Tab action: close all panel views, trigger tab callback
      this._activeViewId = ''
      view.onActivate?.()
      this._render()
      return
    }
    // Panel action: normal sidebar behavior
    this._activate(view.id)
  }

  get collapsed(): boolean {
    return this._collapsed
  }

  get activeViewId(): string | null {
    return this._activeViewId
  }

  toggle(): void {
    this._collapsed = !this._collapsed
    this._storage?.setItem(STORAGE_KEY, this._collapsed ? '1' : '0')
    this._render()
  }

  private _activate(viewId: string): void {
    if (viewId === this._activeViewId && !this._collapsed) {
      // Clicking the active view's icon closes the panel — the VS Code
      // gesture that makes the activity bar double as the collapse control.
      this.toggle()
      return
    }
    this._activeViewId = viewId
    if (this._collapsed) this.toggle()
    else this._render()
  }

  private _render(): void {
    this._title.textContent = this._views.get(this._activeViewId)?.title ?? ''
    this._panel.classList.toggle('collapsed', this._collapsed)
    // Update active state for all buttons — only the current active view gets the class
    for (const [id, btn] of this._buttons) {
      if (id === this._activeViewId && !this._collapsed) {
        btn.classList.add('active')
      } else {
        btn.classList.remove('active')
      }
    }
    // Show/hide content containers
    for (const [id, container] of this._contentContainers) {
      container.style.display = id === this._activeViewId && !this._collapsed ? 'block' : 'none'
    }
  }
}

/** localStorage throws in some embedded webviews when disabled; the sidebar
 *  must still work, just without persistence. */
function safeLocalStorage(): SidebarStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
