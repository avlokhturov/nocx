/**
 * Sidebar — Solid component for the VS Code-style activity bar + collapsible
 * panel.  Fixes nocx-rp2j: separates panel-views from tab-actions, and shows
 * no empty panel at cold start.
 *
 * The activity bar renders buttons for panel views AND tab actions.  The panel
 * only shows content for panel views.  Tab actions open full-screen tabs;
 * clicking one collapses the panel (no empty panel).
 *
 * Mounted via `mountSidebar()` into the bar element; manages the panel element
 * imperatively.  Panel chrome (title, content containers) is created once on
 * the first effect and reactively toggled on state changes.
 */

import { render } from 'solid-js/web'
import { createEffect, createMemo, For, onCleanup } from 'solid-js'
import { createAppStore, type AppActions, type AppState } from './state'

const STORAGE_KEY = 'nocx.sidebar.collapsed'

// ── Types ──────────────────────────────────────────────────────────────────

/** A view whose content is rendered inside the sidebar panel. */
export interface PanelView {
  readonly id: string
  readonly title: string
  /** Inline SVG markup for the activity-bar icon. */
  readonly icon: string
  /** Called with the content container when this view becomes active. */
  readonly mount?: (panel: HTMLElement) => void
}

/** An action button that opens a full-screen tab (not panel content). */
export interface TabAction {
  readonly id: string
  readonly title: string
  /** Inline SVG markup for the activity-bar icon. */
  readonly icon: string
  /** Called when the button is clicked. */
  readonly onActivate?: () => void
}

/** Minimal storage surface — injectable so tests avoid localStorage quirks. */
export interface SidebarStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Handle returned by mountSidebar. */
export interface SidebarHandle {
  destroy(): void
}

function safeLocalStorage(): SidebarStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// ── Union for the combined button list ─────────────────────────────────────

type SidebarItem = ({ kind: 'panel' } & PanelView) | ({ kind: 'tab' } & TabAction)

// ── Solid component ────────────────────────────────────────────────────────

interface SidebarSolidProps {
  bar: HTMLElement
  panel: HTMLElement
  panelViews: readonly PanelView[]
  tabActions: readonly TabAction[]
  storage: SidebarStorage | null
  state: AppState
  actions: AppActions
}

function SidebarSolid(props: SidebarSolidProps) {
  // Combine panel views and tab actions into a single button list
  const items = createMemo<readonly SidebarItem[]>(() => [
    ...props.panelViews.map((v) => ({ kind: 'panel' as const, ...v })),
    ...props.tabActions.map((a) => ({ kind: 'tab' as const, ...a })),
  ])

  // ── Keyboard shortcut: Ctrl/Cmd+B toggles sidebar ──────────────────────
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === 'b') {
        e.preventDefault()
        props.actions.toggleSidebar()
      }
    }
    document.addEventListener('keydown', handler)
    onCleanup(() => document.removeEventListener('keydown', handler))
  })

  // ── Persist collapsed state ────────────────────────────────────────────
  createEffect(() => {
    props.storage?.setItem(STORAGE_KEY, props.state.sidebar.collapsed ? '1' : '0')
  })

  // ── Manage panel chrome (title, collapsed class, content containers) ───
  createEffect(() => {
    const sidebar = props.state.sidebar

    // Create title element on first run
    let titleEl = props.panel.querySelector<HTMLElement>('.sidebar-title')
    if (titleEl === null) {
      titleEl = document.createElement('div')
      titleEl.className = 'sidebar-title'
      props.panel.prepend(titleEl)
    }

    // Check if the active view is a panel view
    const isPanelView = props.panelViews.some((v) => v.id === sidebar.activeViewId)
    const effectivelyCollapsed = sidebar.collapsed || !isPanelView

    // Update panel collapsed class
    props.panel.classList.toggle('collapsed', effectivelyCollapsed)

    // Update title
    const activePanel = props.panelViews.find((v) => v.id === sidebar.activeViewId)
    titleEl.textContent = activePanel?.title ?? ''

    // Create and manage content containers for panel views
    for (const view of props.panelViews) {
      let container = props.panel.querySelector<HTMLElement>(
        `.sidebar-content[data-view="${view.id}"]`,
      )
      if (container === null) {
        container = document.createElement('div')
        container.className = 'sidebar-content'
        container.dataset.view = view.id
        container.style.display = 'none'
        props.panel.append(container)
        view.mount?.(container)
      }
      container.style.display =
        view.id === sidebar.activeViewId && !effectivelyCollapsed ? 'block' : 'none'
    }
  })

  // ── Event handlers ─────────────────────────────────────────────────────
  const handleClick = (item: SidebarItem): void => {
    if (item.kind === 'tab') {
      // Tab action: close the panel, fire callback
      props.actions.collapseSidebar()
      item.onActivate?.()
      return
    }

    // Panel view — VS Code behavior (matching SidebarImpl._activate)
    const { activeViewId, collapsed } = props.state.sidebar
    if (item.id === activeViewId && !collapsed) {
      // Same view while open → collapse
      props.actions.collapseSidebar()
    } else if (collapsed) {
      // Any click while collapsed → switch view and expand
      // The store's setActiveView only sets the view without uncollapsing
      // when already collapsed, so we toggle separately.
      props.actions.setActiveView(item.id)
      props.actions.toggleSidebar()
    } else {
      // Different view while not collapsed → switch
      props.actions.setActiveView(item.id)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <For each={items()}>
      {(item) => (
        <button
          class={
            'activity-bar-btn' +
            (item.kind === 'panel' &&
            item.id === props.state.sidebar.activeViewId &&
            !props.state.sidebar.collapsed
              ? ' active'
              : '')
          }
          data-view={item.id}
          title={item.title}
          aria-label={item.title}
          onClick={() => handleClick(item)}
          ref={(el) => {
            el.innerHTML = item.icon
          }}
        />
      )}
    </For>
  )
}

// ── Mount function ─────────────────────────────────────────────────────────

/**
 * Mount the sidebar Solid component and return a handle to dispose it.
 *
 * Fixes nocx-rp2j: determines the initial active view from the first panel
 * view (not the first item in a mixed list), starts collapsed when there is
 * no panel view, and restores persisted collapsed state from storage.
 *
 * Because panel-views and tab-actions are separate arguments, the button list
 * is never ambiguous: a panel-view shows content in the sidebar panel; a
 * tab-action opens a full-screen tab and collapses the panel.
 */
export function mountSidebar(
  bar: HTMLElement,
  panel: HTMLElement,
  panelViews: readonly PanelView[],
  tabActions: readonly TabAction[],
  storage?: SidebarStorage | null,
): SidebarHandle {
  const safeStorage = storage ?? safeLocalStorage()

  const [state, actions] = createAppStore()

  // ── Fix nocx-rp2j: correct initial state ───────────────────────────────
  const firstPanelViewId = panelViews.length > 0 ? panelViews[0].id : ''
  const persistedCollapsed = safeStorage?.getItem(STORAGE_KEY) === '1'

  // Set active view to the first panel view (skip tab actions)
  if (firstPanelViewId !== state.sidebar.activeViewId) {
    actions.setActiveView(firstPanelViewId)
  }

  // Restore persisted collapsed state, or collapse if no panel view exists
  if (persistedCollapsed || firstPanelViewId === '') {
    if (!state.sidebar.collapsed) {
      actions.collapseSidebar()
    }
  }

  // ── Render the Solid component into the activity bar element ───────────
  const destroy = render(
    () => (
      <SidebarSolid
        bar={bar}
        panel={panel}
        panelViews={panelViews}
        tabActions={tabActions}
        storage={safeStorage}
        state={state}
        actions={actions}
      />
    ),
    bar,
  )

  return { destroy }
}
