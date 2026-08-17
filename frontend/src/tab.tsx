import { Show } from 'solid-js'
import { IconButton } from './ui/icon-button'
import { PinIcon } from './ui/icons'
import type { AgentStatus } from './agent-status'

/**
 * Tab — a feature component for a terminal tab button.
 *
 * KEEPS THE WORD, deliberately (nocx-ehkvy). The rename moved "tab" to "pane"
 * everywhere the symbol holds the durable thing — the pipe, the cwd, the
 * blocks. This is not that thing. It is the STRIP ENTRY: a `role="tab"` button
 * consumed only by TabStrip, which is exactly what the design reserves the word
 * for. The file was briefly renamed to pane.tsx and moved back, so if you are
 * about to rename it again, this paragraph is the reason not to.
 *
 * Renders a `<div role="tab">` with `class="nocx-tab"` and `data-*` / `aria-*`
 * for variance. Tab carries drag/reorder, middle-click close, an activity
 * indicator, an agent-status indicator, and `aria-controls`.
 *
 * This is a feature component (declared in feature-components.json), not a kit
 * primitive — it is a behavioural unit consumed only by TabStrip.
 *
 * Roving tabindex stays with the group (TabStripBase.onTablistKeydown); this
 * component only accepts `tabIndex` and `active`.
 */
export interface TabProps {
  /** Element id, used for aria-labelledby from the pane. */
  id: string
  /** The tab's numeric id, used in callsite identity and data transfer. */
  paneId: number
  /** The pane this tab controls (aria-controls). */
  controlledPaneId: string
  /** 1-based index display. */
  index: number
  /** Whether this tab is active/selected. */
  active: boolean
  /** Agent status for the status indicator. */
  agentStatus: AgentStatus | null
  /** Display title from the reactive store. */
  title: string
  /** Tooltip text from the reactive store — rendered as subtitle in vertical mode. */
  tooltip: string
  /** Whether there is unread activity visible on an inactive tab. */
  hasActivity: boolean
  /** Tabindex for roving tabindex participation. */
  tabIndex: number
  /** Orientation of the tab strip — controls subtitle rendering. Defaults to 'horizontal'. */
  orientation?: 'horizontal' | 'vertical'
  /** When true, the tab row is hidden via CSS (filtering). Defaults to false. */
  hidden?: boolean
  /** The row's second line in vertical placement: the tab's location. Empty when the
   *  title already carries it, in which case no second line is drawn. */
  subtitle?: string
  /** When true, the tab offers a save action (alias adoption). */
  adoptable?: boolean
  /** Triggered when the user clicks the save action. */
  onAdopt?: () => void
  /** The environment degraded or became uncertain (nocx-4t37.2): renders
   *  the small warning mark in the status line. */
  warning?: boolean
  /** What the mark means, for its accessible name and its tooltip. The
   *  session's integration status supplies it (nocx-5uu5) — a mark that
   *  cannot say what it is about is a mark people learn to ignore. Falls
   *  back to the generic wording when nothing more specific is known. */
  warningLabel?: string
  /** The tab's colour, as the backend stores it (nocx-isoph.4): one of the
   *  closed set in layout/tab-colours.ts, or undefined for an undecorated
   *  tab, which is the normal state. It renders as a swatch on the row and
   *  never as a repaint of the tab — the colour is a mark the user put on it,
   *  not a theme of its own. */
  colour?: string
  /** Whether the tab is kept at the head of the strip. The strip does the
   *  keeping (layout/strip-order.ts); this only draws the mark that says why
   *  a tab is where it is. */
  pinned?: boolean
  /** How far in the row is drawn: 0 for a top-level row, +1 per LINEAGE
   *  generation (nocx-isoph.5, layout/strip-tree.ts). Indentation is driven
   *  by the number and never by nested DOM — the same technique the kit's
   *  TreeRow uses — so a row is one row at any depth: it keeps its drag, its
   *  keyboard place and its close. The vertical strip is where the tree is
   *  drawn (§4.3); the horizontal one passes 0 and the attribute is absent.
   *
   *  It is provenance and nothing else. A child is drawn under its parent and
   *  no authority follows from that (ADR-0020 §5). */
  depth?: number
  /** Called when the tab is right-clicked, with the viewport coordinates the
   *  menu should open at. The strip owns the menu; a tab knows only that it
   *  was asked for one. */
  onMenu?: (paneId: number, x: number, y: number) => void
  /** Called when the tab is clicked. */
  onActivate: () => void
  /** Called with the tab id when the tab is closed (middle-click or close button). */
  onClose: (paneId: number) => void
  /** Called when a tab is dropped onto this one: (fromId, toId). */
  onReorder: (fromId: number, toId: number) => void
}

export function Tab(props: TabProps) {
  return (
    <div
      id={props.id}
      class="nocx-tab"
      role="tab"
      aria-controls={props.controlledPaneId}
      aria-selected={props.active}
      data-pane-id={String(props.paneId)}
      data-agent-status={props.agentStatus ?? undefined}
      data-colour={props.colour || undefined}
      data-pinned={props.pinned === true ? 'true' : undefined}
      data-hidden={props.hidden === true ? 'true' : undefined}
      data-depth={(props.depth ?? 0) > 0 ? String(props.depth) : undefined}
      // Kept in BOTH orientations. The vertical row shows the same text as a
      // subtitle, but that line ellipses — so dropping the native tooltip there
      // took away the only way to read a long path in full.
      title={props.tooltip}
      draggable={true}
      tabIndex={props.tabIndex}
      onClick={() => props.onActivate()}
      onContextMenu={(e: MouseEvent) => {
        if (!props.onMenu) return
        // The browser's own menu here offers nothing about a tab, and the
        // strip's actions (rename, colour, pin) have no other home in the
        // horizontal strip — there is no room for a control per action on a
        // row this narrow.
        e.preventDefault()
        e.stopPropagation()
        props.onMenu(props.paneId, e.clientX, e.clientY)
      }}
      onMouseDown={(e: MouseEvent) => {
        if (e.button === 1) {
          e.preventDefault()
          props.onClose(props.paneId)
        }
      }}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer?.setData('text/plain', String(props.paneId))
        if (e.currentTarget instanceof HTMLElement) {
          e.currentTarget.classList.add('dragging')
        }
      }}
      onDragEnd={(e: DragEvent) => {
        if (e.currentTarget instanceof HTMLElement) {
          e.currentTarget.classList.remove('dragging')
        }
      }}
      onDragOver={(e: DragEvent) => {
        e.preventDefault()
      }}
      onDrop={(e: DragEvent) => {
        e.preventDefault()
        const draggedId = Number(e.dataTransfer?.getData('text/plain'))
        if (!Number.isNaN(draggedId) && draggedId !== props.paneId) {
          props.onReorder(draggedId, props.paneId)
        }
      }}
    >
      <span class="nocx-tab-index">{props.index + 1}</span>
      <span class="nocx-tab-label">
        {/* The status dot belongs ON the title's line, not above it. In the
            vertical row the label is a column, so a status span sitting beside
            the title became a third row of its own — 10px tall even when the dot
            is not showing — and pushed the two visible lines below the row's
            centre. Wrapping the pair keeps the column at exactly two children. */}
        <span class="nocx-tab-line">
          <span class="nocx-tab-status" />
          {/* Why this tab is at the head of the strip. Without the mark the
              pinning is invisible until the strip is long enough for the
              order to be surprising, which is the moment it is least
              welcome. */}
          <Show when={props.pinned === true}>
            <span class="nocx-tab-pin" aria-label="Pinned" title="Pinned">
              <PinIcon />
            </span>
          </Show>
          <Show when={props.warning === true}>
            <span
              class="nocx-tab-warning"
              aria-label={props.warningLabel ?? 'Environment degraded'}
              title={props.warningLabel ?? 'Shell integration degraded or uncertain'}
            />
          </Show>
          <span class="nocx-tab-title">{props.title}</span>
        </span>
        <Show when={props.orientation === 'vertical' && (props.subtitle ?? '') !== ''}>
          <span class="nocx-tab-subtitle">{props.subtitle}</span>
        </Show>
      </span>
      <Show when={props.adoptable === true}>
        <IconButton
          size="sm"
          ariaLabel="Save as connection"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            props.onAdopt?.()
          }}
          square
        >
          {'+'}
        </IconButton>
      </Show>
      <IconButton
        size="sm"
        ariaLabel="Close tab"
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          props.onClose(props.paneId)
        }}
      >
        {'\u00d7'}
      </IconButton>
      <div
        class="nocx-tab-indicator"
        data-activity={props.hasActivity && !props.active ? 'true' : undefined}
      />
    </div>
  )
}
