import { For, Show, createSignal } from 'solid-js'
import { Tab } from './tab'
import { IconButton } from './ui/icon-button'
import { ContextMenu } from './ui/context-menu'
import { TAB_COLOURS } from './layout/tab-colours'
import { SearchField } from './ui/search-field'
import { ChevronDownIcon, KeyIcon, PlusIcon, TextQuoteIcon } from './ui/icons'
import type { Setter } from 'solid-js'
import { createStore } from 'solid-js/store'
import { render } from 'solid-js/web'
import type { AgentStatus } from './agent-status'

// ═══════════════════════════════════════════════════════════════════════════
// TabStrip — presentation port for tab chrome
// ═══════════════════════════════════════════════════════════════════════════

/** The display state a TabStrip reads from each tab. */
export interface PaneView {
  readonly id: number
  readonly title: string
  /** Title shown before content publishes its first dynamic title. */
  readonly displayTitle?: string
  readonly hasActivity: boolean
  readonly agentStatus: AgentStatus | null
  readonly tooltip: string
  /** The tab's location for the strip's second line, or '' when the title already
   *  says it — see Tab.subtitle. */
  readonly subtitle: string
  /** When true, the tab offers a save action (alias adoption). */
  readonly adoptable?: boolean
  readonly onAdopt?: (() => void) | null
  /** The environment degraded or became uncertain (nocx-4t37.2): tab
   *  chrome carries at most this warning mark, never a permanent badge. */
  readonly warning?: boolean
  /** What the mark means (nocx-5uu5). */
  readonly warningLabel?: string
  /** The tab's colour as the BACKEND stores it, or null for an undecorated
   *  tab (nocx-isoph.4, §4.5). The strip renders it and never chooses it. */
  readonly colour?: string | null
  /** Whether the backend has this tab pinned. The strip draws the mark and
   *  places the tab (layout/strip-order.ts); the flag is stored. */
  readonly pinned?: boolean
  readonly paneId: string
  onDisplayChange: (() => void) | null
}

/**
 * Reactive display-state record for a single tab, keyed by tab id.
 * Stored in a local Solid store so JSX expressions (each compiled into
 * their own reactive computation) are fine-grained reactive.
 * Uses displayTitle when the content has not published a dynamic title yet.
 */
interface PaneDisplayRecord {
  title: string
  tooltip: string
  subtitle: string
  adoptable: boolean
  warning: boolean
  warningLabel: string
  hasActivity: boolean
  agentStatus: AgentStatus | null
  colour: string | null
  pinned: boolean
}

/** Presentation port for tab chrome. */
export interface TabStrip {
  readonly orientation: Orientation
  mount(container: HTMLElement): void
  addPane(tab: PaneView): void
  removePane(paneId: number): void
  setActive(paneId: number): void
  reorder(tabs: readonly PaneView[]): void
  onActivate: ((paneId: number) => void) | null
  onClose: ((paneId: number) => void) | null
  onNewPane: (() => void) | null
  onReorder: ((fromId: number, toId: number) => void) | null
  /** The tab's decoration, asked for from its context menu (nocx-isoph.4).
   *  Three intents rather than one "update": a patch where a missing field
   *  and a null field mean different things is how "what changed" stops
   *  being answerable, which is the same reason the wire has three methods.
   *  The strip raises them; the backend decides and the strip re-renders. */
  onRename: ((paneId: number) => void) | null
  /** null clears the colour, which is a real operation and not a no-op. */
  onRecolour: ((paneId: number, colour: string | null) => void) | null
  onPin: ((paneId: number, pinned: boolean) => void) | null
  onQuickConnect: (() => void) | null
  onInsertSecret: (() => void) | null
  /** The snippets action was pressed. Shaped exactly like onQuickConnect
   *  and onInsertSecret because it opens exactly what they open — the same
   *  palette, in its snippets variant (design §10.3). The strip knows
   *  nothing about a library. */
  onSnippets: (() => void) | null
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal types
// ═══════════════════════════════════════════════════════════════════════════

export type Orientation = 'horizontal' | 'vertical'

// ═══════════════════════════════════════════════════════════════════════════
// TabStripBase — Solid renders every tab button via <For>, keyed by tab
// object identity. Display-state reactivity comes from a local store
// (createStore) that mirrors onDisplayChange-driven updates; the JSX reads
// store values inline (never hoisted into local variables), so Solid
// compiles each JSX expression into its own reactive computation.
// No createEffect or DOM patching is needed.
// ═══════════════════════════════════════════════════════════════════════════

abstract class TabStripBase implements TabStrip {
  protected dispose: (() => void) | null = null
  protected container: HTMLElement | null = null
  private mounted = false

  // Solid stores/signals — set during mount(), used by imperative API
  private _setPaneViews!: Setter<PaneView[]>
  private _getPaneViews!: () => PaneView[]
  private _setDisplay!: (...args: unknown[]) => void

  public abstract readonly orientation: Orientation

  // Intent callbacks
  onActivate: ((paneId: number) => void) | null = null
  onClose: ((paneId: number) => void) | null = null
  onNewPane: (() => void) | null = null
  onReorder: ((fromId: number, toId: number) => void) | null = null
  onRename: ((paneId: number) => void) | null = null
  onRecolour: ((paneId: number, colour: string | null) => void) | null = null
  onPin: ((paneId: number, pinned: boolean) => void) | null = null
  onQuickConnect: (() => void) | null = null
  onInsertSecret: (() => void) | null = null
  onSnippets: (() => void) | null = null

  /** Subclasses set up container attributes (class, aria). */
  protected abstract setupContainer(container: HTMLElement): void

  mount(container: HTMLElement): void {
    if (this.mounted) return
    this.mounted = true
    this.container = container

    this.setupContainer(container)
    container.addEventListener('keydown', this.onTablistKeydown)
    this.dispose = render(() => {
      const [paneViews, setPaneViews] = createSignal<PaneView[]>([])
      const [display, setDisplay] = createStore<{
        records: Record<number, PaneDisplayRecord>
        activeId: number
      }>({ records: {}, activeId: -1 })
      const [searchQuery, setSearchQuery] = createSignal('')
      // The tab menu: which tab it belongs to and where it was opened. One
      // menu for the whole strip rather than one per row — a menu is a
      // singleton on screen, and a component per tab would be N listeners
      // for a thing at most one of which can be open.
      const [menu, setMenu] = createSignal<{ paneId: number; x: number; y: number } | null>(null)

      this._getPaneViews = paneViews
      this._setPaneViews = setPaneViews
      this._setDisplay = setDisplay

      /** The actions a tab offers, in the order they are reached for. The
       *  strip builds the rows; every one of them raises an intent and
       *  decides nothing — the answer comes back through the store. */
      const menuItems = (paneId: number) => {
        const record = display.records[paneId]
        const pinned = record?.pinned === true
        const items = [
          { id: 'rename', label: 'Rename…', onSelect: () => this.onRename?.(paneId) },
          {
            id: 'pin',
            label: pinned ? 'Unpin' : 'Pin',
            onSelect: () => this.onPin?.(paneId, !pinned),
          },
          ...TAB_COLOURS.map((c) => ({
            id: `colour-${c.key}`,
            label: c.label,
            onSelect: () => this.onRecolour?.(paneId, c.key),
          })),
        ]
        if (record?.colour) {
          items.push({
            id: 'colour-none',
            label: 'No colour',
            onSelect: () => this.onRecolour?.(paneId, null),
          })
        }
        items.push({ id: 'close', label: 'Close', onSelect: () => this.onClose?.(paneId) })
        return items
      }

      return (
        <>
          <Show when={this.orientation === 'vertical'}>
            <div class="tabstrip-header">
              <div class="tabstrip-search">
                <SearchField
                  value={searchQuery()}
                  onInput={(v) => setSearchQuery(v)}
                  placeholder="Filter tabs…"
                  ariaLabel="Filter tabs"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && searchQuery() !== '') {
                      e.stopPropagation()
                    }
                  }}
                />
              </div>
              <div class="tabstrip-actions">
                <IconButton ariaLabel="New tab" square onClick={() => this.onNewPane?.()}>
                  <PlusIcon />
                </IconButton>
                <IconButton
                  ariaLabel="Quick connect"
                  onClick={() => this.onQuickConnect?.()}
                  tabIndex={-1}
                >
                  <ChevronDownIcon />
                </IconButton>
                <IconButton
                  ariaLabel="Insert a secret"
                  title="Insert a secret"
                  onClick={() => this.onInsertSecret?.()}
                  tabIndex={-1}
                >
                  <KeyIcon />
                </IconButton>
                <IconButton
                  ariaLabel="Snippets"
                  title="Snippets"
                  onClick={() => this.onSnippets?.()}
                  tabIndex={-1}
                >
                  <TextQuoteIcon />
                </IconButton>
              </div>
            </div>
          </Show>
          <div class="tabs-container">
            <For each={paneViews()}>
              {(tab, index) => (
                <Tab
                  id={`tab-btn-${tab.id}`}
                  paneId={tab.id}
                  controlledPaneId={tab.paneId}
                  index={index()}
                  active={display.activeId === tab.id}
                  agentStatus={display.records[tab.id]?.agentStatus ?? null}
                  adoptable={display.records[tab.id]?.adoptable === true}
                  warning={display.records[tab.id]?.warning === true}
                  warningLabel={display.records[tab.id]?.warningLabel || undefined}
                  onAdopt={tab.onAdopt ?? undefined}
                  title={display.records[tab.id]?.title ?? ''}
                  tooltip={display.records[tab.id]?.tooltip ?? ''}
                  subtitle={display.records[tab.id]?.subtitle ?? ''}
                  hasActivity={display.records[tab.id]?.hasActivity === true}
                  tabIndex={display.activeId === tab.id ? 0 : -1}
                  orientation={this.orientation}
                  hidden={(() => {
                    const q = searchQuery().toLowerCase().trim()
                    if (!q) return false
                    const r = display.records[tab.id]
                    return (
                      !(r?.title ?? '').toLowerCase().includes(q) &&
                      !(r?.tooltip ?? '').toLowerCase().includes(q)
                    )
                  })()}
                  colour={display.records[tab.id]?.colour ?? undefined}
                  pinned={display.records[tab.id]?.pinned === true}
                  onActivate={() => this.onActivate?.(tab.id)}
                  onClose={(id) => this.onClose?.(id)}
                  onReorder={(fromId, toId) => this.onReorder?.(fromId, toId)}
                  onMenu={(paneId, x, y) => setMenu({ paneId, x, y })}
                />
              )}
            </For>
          </div>
          <Show when={menu()} keyed>
            {(open) => (
              <ContextMenu
                open
                x={open.x}
                y={open.y}
                items={menuItems(open.paneId)}
                onClose={() => setMenu(null)}
                data-testid="tab-menu"
              />
            )}
          </Show>
          <Show when={this.orientation === 'horizontal'}>
            {/* The strip's actions, as one group. They were two loose siblings of
                the tab list, which the vertical strip then spread down the whole
                column — the list is `flex: 1 1 auto`, so it pushed them apart and
                left the caret alone in the bottom corner. As a group they can be
                placed once, per orientation, by the strip's own CSS. */}
            <div class="tabstrip-actions">
              <IconButton ariaLabel="New tab" onClick={() => this.onNewPane?.()}>
                <PlusIcon />
              </IconButton>
              <IconButton
                ariaLabel="Quick connect"
                onClick={() => this.onQuickConnect?.()}
                tabIndex={-1}
              >
                <ChevronDownIcon />
              </IconButton>
              <IconButton
                ariaLabel="Insert a secret"
                title="Insert a secret"
                onClick={() => this.onInsertSecret?.()}
                tabIndex={-1}
              >
                <KeyIcon />
              </IconButton>
              <IconButton
                ariaLabel="Snippets"
                title="Snippets"
                onClick={() => this.onSnippets?.()}
                tabIndex={-1}
              >
                <TextQuoteIcon />
              </IconButton>
            </div>
            <div class="tabbar-spacer" />
          </Show>
        </>
      )
    }, container)
  }

  addPane(tab: PaneView): void {
    if (!this.mounted) return

    // Wire display-change notification to write changed fields into the store.
    tab.onDisplayChange = () => {
      this._setDisplay('records', tab.id, {
        title: tab.displayTitle ?? tab.title,
        tooltip: tab.tooltip,
        subtitle: tab.subtitle,
        adoptable: tab.adoptable,
        warning: tab.warning,
        warningLabel: tab.warningLabel ?? '',
        hasActivity: tab.hasActivity,
        agentStatus: tab.agentStatus,
        colour: tab.colour ?? null,
        pinned: tab.pinned === true,
      })
    }

    this._setPaneViews((prev) => [...prev, tab])

    // Initialize store entry with current display state.
    this._setDisplay('records', tab.id, {
      title: tab.displayTitle ?? tab.title,
      tooltip: tab.tooltip,
      subtitle: tab.subtitle,
      adoptable: tab.adoptable,
      warning: tab.warning,
      warningLabel: tab.warningLabel ?? '',
      hasActivity: tab.hasActivity,
      agentStatus: tab.agentStatus,
      colour: tab.colour ?? null,
      pinned: tab.pinned === true,
    })

    // Link pane to button (aria-labelledby)
    const pane = document.getElementById(tab.paneId)
    if (pane) pane.setAttribute('aria-labelledby', `tab-btn-${tab.id}`)
  }

  removePane(paneId: number): void {
    if (!this.mounted) return
    this._setPaneViews((prev) => {
      const removed = prev.find((t) => t.id === paneId)
      if (removed) removed.onDisplayChange = null
      return prev.filter((t) => t.id !== paneId)
    })
    // Delete store entry — functional update avoids referencing current state.
    this._setDisplay('records', (prev: Record<number, PaneDisplayRecord>) => {
      const next = { ...prev }
      delete next[paneId]
      return next
    })
  }

  setActive(paneId: number): void {
    if (!this.mounted) return
    this._setDisplay('activeId', paneId)
  }

  reorder(tabs: readonly PaneView[]): void {
    if (!this.mounted) return
    // Solid's <For> reconciliation clears focus when it moves a node with
    // insertBefore, even though the node itself survives — keyed identity is
    // necessary here and not sufficient (nocx-82l9.8). Signal setters run their
    // dependent effects synchronously outside a batch, so the DOM is settled by
    // the time _setPaneViews returns and restoring focus here is enough.
    const active = document.activeElement
    this._setPaneViews([...tabs])
    if (active instanceof HTMLElement && this.container?.contains(active)) {
      active.focus({ preventScroll: true })
    }
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

    const paneId = Number(button.getAttribute('data-pane-id'))
    if (Number.isNaN(paneId)) return

    const tabs = this._getPaneViews()
    const idx = tabs.findIndex((t) => t.id === paneId)
    if (idx === -1) return

    const len = tabs.length
    let nextIdx: number
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

    const nextPane = tabs[nextIdx]
    if (nextPane) {
      const nextBtn = document.getElementById(`tab-btn-${nextPane.id}`)
      nextBtn?.focus()
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HorizontalTabStrip
// ═══════════════════════════════════════════════════════════════════════════

export class HorizontalTabStrip extends TabStripBase {
  public readonly orientation: Orientation = 'horizontal'

  protected setupContainer(container: HTMLElement): void {
    container.classList.add('tabbar')
    container.setAttribute('role', 'tablist')
    container.setAttribute('aria-label', 'Terminal tabs')
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VerticalTabStrip
// ═══════════════════════════════════════════════════════════════════════════

export class VerticalTabStrip extends TabStripBase {
  public readonly orientation: Orientation = 'vertical'

  protected setupContainer(container: HTMLElement): void {
    container.classList.add('tabstrip-vertical')
    container.setAttribute('role', 'tablist')
    container.setAttribute('aria-label', 'Terminal tabs')
  }
}
