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

/** A view the activity bar can show. Content mounting arrives with the
 *  first real view; today the panel shows the view title only. */
export interface SidebarView {
  readonly id: string
  readonly title: string
  /** Inline SVG markup for the activity-bar icon. */
  readonly icon: string
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
  private readonly _title: HTMLElement

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
      btn.addEventListener('click', () => this._activate(view.id))
      bar.append(btn)
      this._buttons.set(view.id, btn)
    }

    this._title = document.createElement('div')
    this._title.className = 'sidebar-title'
    this._panel.append(this._title)

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === 'b') {
        this.toggle()
      }
    })

    this._render()
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
    for (const [id, btn] of this._buttons) {
      btn.classList.toggle('active', id === this._activeViewId && !this._collapsed)
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
