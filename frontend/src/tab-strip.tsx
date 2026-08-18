import { For, Show, createSignal } from 'solid-js'
import { Tab } from './tab'
import { IconButton } from './ui/icon-button'
import { ContextMenu } from './ui/context-menu'
import { Caption } from './ui/caption'
import { TAB_COLOURS } from './layout/tab-colours'
import { groupStrip } from './layout/strip-groups'
import { SearchField } from './ui/search-field'
import { WorkspaceChip, type WorkspaceChipView } from './workspace-chip'
import type { WorkspaceMenuRow } from './workspace-menu'
import { ChevronDownIcon, KeyIcon, LayersIcon, PlusIcon, TextQuoteIcon } from './ui/icons'
import type { JSX, Setter } from 'solid-js'
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
  /** Which group this row is drawn under (nocx-isoph.5). The AXIS is the
   *  caller's — workspace here, `descriptor.surfaceType` in nocx-jv3q.1,
   *  project/host/worktree/branch in design §9 — and the strip only cuts the
   *  list where the key changes. Absent means "not grouped", which is one
   *  anonymous group and exactly what an ungrouped strip already looked
   *  like. */
  readonly groupKey?: string
  /** How far in the row is drawn: 0 for a top-level row, +1 per lineage
   *  generation (layout/strip-tree.ts). The horizontal strip is flat — the
   *  tree stays in the vertical one (§4.3). */
  readonly depth?: number
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
  groupKey: string
  depth: number
}

/** What stands above one group of rows, or null for a group that draws no
 *  heading — the default workspace's, which is top-level rows and nothing
 *  else (§4.2). The strip is TOLD these; deciding one is the axis's job
 *  (layout/strip-groups.ts). */
interface StripGroupHeading {
  readonly key: string
  readonly heading: string | null
}

/** A heading in the strip's flat list of things to draw. An object rather
 *  than a bare string so it is told apart from a row by shape, and so it can
 *  keep a stable identity across redraws.
 *
 *  It carries its group's KEY as well as its text (nocx-isoph.7): a heading is
 *  the vertical strip's handle on the workspace it heads, and a menu opened
 *  from it has to name a subject. Deriving the subject from the text would be
 *  a second, lossier identity — two workspaces may be called the same thing. */
interface StripHeadingItem {
  readonly key: string
  readonly heading: string
}

function isHeading(item: StripHeadingItem | PaneView): item is StripHeadingItem {
  return 'heading' in item
}

/** How deep a row is drawn before the indent stops growing. A 240px column
 *  cannot indent forever, and a label squeezed to nothing is worse than a
 *  generation that shares its neighbour's indent. The DEPTH is unbounded; the
 *  drawing of it is not. */
const MAX_DRAWN_DEPTH = 6

/** Presentation port for tab chrome. */
export interface TabStrip {
  readonly orientation: Orientation
  mount(container: HTMLElement): void
  addPane(tab: PaneView): void
  removePane(paneId: number): void
  setActive(paneId: number): void
  reorder(tabs: readonly PaneView[]): void
  /** What to write above each group. The strip cuts its rows by the key each
   *  row carries and looks the heading up here, so a group nobody named draws
   *  none — and no row can go missing for want of a heading. */
  setGroupHeadings(headings: readonly StripGroupHeading[]): void
  /** Which workspace this window is showing, and what else it could show.
   *  Null while there is no chain to draw it from. Only the horizontal strip
   *  renders it: the vertical one shows every workspace at once, so a chip
   *  there would be a second answer to a question it already answers. */
  setWorkspaceChip(chip: WorkspaceChipView | null): void
  onSwitchWorkspace: ((workspaceId: string) => void) | null
  onNewWorkspace: (() => void) | null
  /** The rows a workspace's own menu offers, asked for per heading
   *  (nocx-isoph.7). The strip DECIDES none of them: it is handed the rows by
   *  whoever owns the workspace set, exactly as it is handed a heading rather
   *  than working one out. Null when there is no chain to act on. */
  workspaceMenuRows: ((workspaceId: string) => WorkspaceMenuRow[]) | null
  /** The CURRENT workspace was asked to close. The strip names no workspace
   *  in this intent — it shows one at a time, so "the current one" is the
   *  only thing it can mean, and the ask and the close belong to
   *  PaneManager.closeWorkspace (nocx-isoph.6). */
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
  private _setGroupHeadings!: Setter<StripGroupHeading[]>
  private _setChip!: Setter<WorkspaceChipView | null>
  /** What the strip was told before it was mounted. A caller that sets the
   *  chip or the headings first and mounts second must not lose them — the
   *  composition root replaces the whole strip when the placement setting
   *  changes, and the order of those two calls is not its business. */
  private pendingHeadings: StripGroupHeading[] = []
  private pendingChip: WorkspaceChipView | null = null

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
  onSwitchWorkspace: ((workspaceId: string) => void) | null = null
  onNewWorkspace: (() => void) | null = null
  workspaceMenuRows: ((workspaceId: string) => WorkspaceMenuRow[]) | null = null

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
      // The workspace menu is its OWN signal rather than a variant of the tab
      // menu above: the two are opened from different things, carry different
      // rows and can be reached in the same frame, and one signal holding
      // either would make "which menu is open" a question with two answers.
      const [workspaceMenu, setWorkspaceMenu] = createSignal<{
        rows: WorkspaceMenuRow[]
        x: number
        y: number
      } | null>(null)
      const [groupHeadings, setGroupHeadings] = createSignal<StripGroupHeading[]>(
        this.pendingHeadings,
      )
      const [chip, setChip] = createSignal<WorkspaceChipView | null>(this.pendingChip)

      this._getPaneViews = paneViews
      this._setPaneViews = setPaneViews
      this._setDisplay = setDisplay
      this._setGroupHeadings = setGroupHeadings
      this._setChip = setChip

      /**
       * What the strip draws, top to bottom: headings and rows in one list.
       *
       * THE CUT IS THE SHARED MECHANISM (layout/strip-groups.ts) and the axis
       * is an input: this strip groups by whatever key each row carries and
       * looks the heading up in what it was told. Which axis that is — the
       * workspace here, the surface type in nocx-jv3q.1, project or host or
       * worktree or branch in design §9 — is decided outside, so a second
       * axis is a different `groupKey`, never a second grouping.
       *
       * A HEADING GATHERS ITS ROWS; A GROUP WITH NO HEADING IS JUST ROWS, AND
       * THEY DO NOT MOVE. That is the default workspace, whose tabs are
       * top-level rows and nothing else (§4.2) — and it is also what keeps a
       * pane the chain does not hold (Settings, a viewer) exactly where it
       * already was. Sweeping those to the end broke "the last tab is the one
       * that just opened" in four e2e specs once already.
       *
       * One flat list rather than a list of groups, and that is not a style
       * choice: `<For>` reconciles by REFERENCE, so a list whose items are
       * freshly built group objects rebuilds every row's DOM on every change —
       * and with it focus, the drag in progress and the node identity
       * ADR-0012 §1 depends on. The rows here are the same PaneView objects
       * throughout, and a heading keeps its identity through `headingItems`.
       */
      const headingItems = new Map<string, StripHeadingItem>()
      const headingItem = (key: string, heading: string): StripHeadingItem => {
        const cached = headingItems.get(`${key} ${heading}`)
        if (cached) return cached
        const item: StripHeadingItem = { key, heading }
        headingItems.set(`${key} ${heading}`, item)
        return item
      }
      /** Whether a row survives the strip's filter. Rows are HIDDEN rather
       *  than removed — a filtered row keeps its DOM, its identity and its
       *  place — so this is also what a heading has to ask before it draws:
       *  a heading over a group the filter has emptied reads as a broken
       *  list. */
      const matchesFilter = (view: PaneView): boolean => {
        const q = searchQuery().toLowerCase().trim()
        if (!q) return true
        const record = display.records[view.id]
        return (
          (record?.title ?? '').toLowerCase().includes(q) ||
          (record?.tooltip ?? '').toLowerCase().includes(q)
        )
      }

      const items = (): Array<StripHeadingItem | PaneView> => {
        const rows = paneViews()
        const groups = groupStrip(rows, {
          key: (view) => display.records[view.id]?.groupKey ?? '',
          heading: (key) => groupHeadings().find((g) => g.key === key)?.heading ?? null,
        })
        const out: Array<StripHeadingItem | PaneView> = []
        const gathered = new Set<string>()
        for (const row of rows) {
          const group = groups.find((g) => g.rows.includes(row))
          if (!group || group.heading === null) {
            out.push(row)
            continue
          }
          if (gathered.has(group.key)) continue
          gathered.add(group.key)
          if (group.rows.some(matchesFilter)) out.push(headingItem(group.key, group.heading))
          out.push(...group.rows)
        }
        return out
      }

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

      /** One thing the strip draws: a group heading, or a tab row. Written
       *  as a function rather than a conditional inside the list so each
       *  branch is a plain expression — and so the Tab's props are read once,
       *  per item, exactly as they were before headings existed. */
      const drawItem = (item: StripHeadingItem | PaneView): JSX.Element => {
        if (isHeading(item)) {
          // THE HEADING IS THE HANDLE (nocx-isoph.7). A vertical strip shows
          // every workspace at once, so the thing standing above a group is
          // where that workspace's own actions belong — the chip is the same
          // mechanism placed on the other orientation, and both take their
          // rows from workspace-menu.ts so they cannot come to disagree about
          // what a workspace may do.
          //
          // It stays a heading and does not become a button: the element, its
          // class and its Caption are unchanged, and the click is added to
          // them. A row that turned into a control when a second workspace
          // existed would be chrome appearing on a counter, which is the rule
          // §4.2 withdrew.
          return (
            <div
              class="tabstrip-group-heading"
              onClick={(e: MouseEvent) => {
                const rows = this.workspaceMenuRows?.(item.key) ?? []
                if (rows.length === 0) return
                const anchor = e.currentTarget
                if (!(anchor instanceof HTMLElement)) return
                const rect = anchor.getBoundingClientRect()
                setWorkspaceMenu({ rows, x: rect.left, y: rect.bottom })
              }}
            >
              <Caption size="context">{item.heading}</Caption>
            </div>
          )
        }
        return (
          <Tab
            id={`tab-btn-${item.id}`}
            paneId={item.id}
            controlledPaneId={item.paneId}
            index={paneViews().indexOf(item)}
            depth={Math.min(display.records[item.id]?.depth ?? 0, MAX_DRAWN_DEPTH)}
            active={display.activeId === item.id}
            agentStatus={display.records[item.id]?.agentStatus ?? null}
            adoptable={display.records[item.id]?.adoptable === true}
            warning={display.records[item.id]?.warning === true}
            warningLabel={display.records[item.id]?.warningLabel || undefined}
            onAdopt={item.onAdopt ?? undefined}
            title={display.records[item.id]?.title ?? ''}
            tooltip={display.records[item.id]?.tooltip ?? ''}
            subtitle={display.records[item.id]?.subtitle ?? ''}
            hasActivity={display.records[item.id]?.hasActivity === true}
            tabIndex={display.activeId === item.id ? 0 : -1}
            orientation={this.orientation}
            hidden={!matchesFilter(item)}
            colour={display.records[item.id]?.colour ?? undefined}
            pinned={display.records[item.id]?.pinned === true}
            onActivate={() => this.onActivate?.(item.id)}
            onClose={(id) => this.onClose?.(id)}
            onReorder={(fromId, toId) => this.onReorder?.(fromId, toId)}
            onMenu={(paneId, x, y) => setMenu({ paneId, x, y })}
          />
        )
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
                {/* CREATION CANNOT LIVE ON A HEADING (nocx-isoph.7). The
                    default workspace draws none — that is §4.2 and it is not
                    negotiable — so a user whose tabs are all in the default
                    sees no heading at all, and a create offered only there
                    would be unreachable exactly for the person who has never
                    made a workspace. It is an action of the STRIP, so it sits
                    with the strip's actions, and the chip carries the same
                    intent on the other orientation. */}
                <IconButton
                  ariaLabel="New workspace"
                  title="New workspace"
                  onClick={() => this.onNewWorkspace?.()}
                  tabIndex={-1}
                >
                  <LayersIcon />
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
          <Show when={this.orientation === 'horizontal' && chip()} keyed>
            {(view) => (
              <WorkspaceChip
                name={view.name}
                currentId={view.currentId}
                workspaces={view.workspaces}
                onSwitch={(id) => this.onSwitchWorkspace?.(id)}
                onNew={() => this.onNewWorkspace?.()}
                // The SAME rows a vertical heading opens, for the workspace
                // this chip is showing (nocx-isoph.7).
                actions={this.workspaceMenuRows?.(view.currentId) ?? []}
              />
            )}
          </Show>
          <div class="tabs-container">
            {/* A group with no heading draws NOTHING above its rows — no
                element, no empty caption, no wrapper. That is what makes the
                default workspace's rows top-level rows (§4.2) rather than
                rows under a blank header, and it is why the default's chrome
                is identical whether or not another workspace exists. */}
            <For each={items()}>{(item) => drawItem(item)}</For>
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
          <Show when={workspaceMenu()} keyed>
            {(open) => (
              <ContextMenu
                open
                x={open.x}
                y={open.y}
                items={open.rows}
                onClose={() => setWorkspaceMenu(null)}
                data-testid="workspace-menu"
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
        groupKey: tab.groupKey ?? '',
        depth: tab.depth ?? 0,
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
      groupKey: tab.groupKey ?? '',
      depth: tab.depth ?? 0,
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

  setGroupHeadings(headings: readonly StripGroupHeading[]): void {
    this.pendingHeadings = [...headings]
    if (this.mounted) this._setGroupHeadings(this.pendingHeadings)
  }

  setWorkspaceChip(chip: WorkspaceChipView | null): void {
    this.pendingChip = chip
    // A signal holding an object needs the functional form, or Solid takes
    // the object for an updater and calls it.
    if (this.mounted) this._setChip(() => chip)
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
