/**
 * TreeRow — the kit's first tree-shaped component: one line of a file tree.
 *
 * A row is one entry and every visual decision about it lives here, in
 * tree-row.css — a surface may place the row, never repaint it. Anything a
 * caller might want to vary is a typed `data-*` variant, not a prop that takes
 * a colour or a class.
 *
 * Variance:
 * - `data-depth` — indentation, driven by the number, not by nested DOM.
 * - `data-kind` — `regular` | `dir` | `symlink` | `other` | `unreadable`. These
 *   are the wire's
 *   words (design §5.1 `Kind`), deliberately: the panel passes an entry's kind
 *   straight through, so there is no mapping layer for a defect to live in.
 *   `other` is a FIFO, socket, device or procfs pseudo-file — it lists, and it
 *   is neither openable nor expandable. `unreadable` is not a kind of object
 *   but a kind of failure: the entry exists and its metadata could not be
 *   read. It renders, so a listing never silently omits what it saw.
 * - `data-link-kind` — the same vocabulary, on symlinks only: what the link
 *   resolves to, and `other` when it resolves to nothing.
 *
 * A row NEVER decides what may be opened; that is the backend's, from metadata
 * it read at call time (design §5.1). The row only renders what it was told.
 * - `data-cyclic="true"` — a symlink that resolves back into an already
 *   expanded ancestor (design D9). It renders as a leaf that cannot be
 *   expanded, whatever `onToggle` is supplied.
 * - `data-disclosure` — `expanded` | `collapsed` | `leaf`. Expandable is
 *   derived from kind, not asked for: a directory or a directory symlink gets
 *   a disclosure; a file, a broken symlink and a cyclic symlink do not.
 * - `data-selected` / `data-focused` — the panel's focus and selection
 *   vocabulary; the row only renders them.
 * - `data-disabled="true"` — unreadable (permission denied is a real state
 *   that renders, never a silently empty row). Disables the disclosure too.
 * - `data-busy="true"` — a directory is loading; its disclosure is disabled.
 *
 * Accessibility: the row is a `treeitem` with `aria-level` (1-based), the
 * expanded state is announced on the row, and the disclosure is a native
 * button — reachable and operable with Enter/Space, `aria-expanded` included.
 * The name is a single line that ellipsises; it never clips a glyph.
 */
import { Show, type JSX } from 'solid-js'
import { ChevronDownIcon } from './icons'

export type TreeRowKind = 'regular' | 'dir' | 'symlink' | 'other' | 'unreadable'

export interface TreeRowProps {
  /** The entry's display name, shown in the row's text. */
  name: string
  /** 0-based depth. Indentation is driven by this number, not by nesting. */
  depth: number
  kind: TreeRowKind
  /** What a symlink resolves to; only meaningful when `kind === 'symlink'`. */
  linkKind?: TreeRowKind
  /** Symlink that resolves into an already-expanded ancestor (design D9). */
  cyclic?: boolean
  selected?: boolean
  focused?: boolean
  /** Unreadable (permission denied). Renders the state; never a silent row. */
  disabled?: boolean
  /** True while a directory is loading; disables the disclosure. */
  busy?: boolean
  /** Expanded state; only consulted on rows that are expandable. */
  expanded?: boolean
  /** Called when the disclosure is activated (click, Enter, Space). */
  onToggle?: (e: MouseEvent) => void
  /** Optional trailing slot, e.g. a kit Badge. */
  badge?: JSX.Element
}

/** A row is expandable from its kind alone: dir, or a symlink into a dir
 *  that is not cyclic. A cyclic symlink is a leaf whatever the caller asks. */
export function isExpandable(kind: TreeRowKind, linkKind?: TreeRowKind, cyclic?: boolean): boolean {
  if (kind === 'dir') return true
  if (kind === 'symlink' && linkKind === 'dir') return !cyclic
  return false
}

export function TreeRow(props: TreeRowProps) {
  const expandable = () => isExpandable(props.kind, props.linkKind, props.cyclic)
  const expanded = () => expandable() && props.expanded === true
  const disclosure = () => (expandable() ? (expanded() ? 'expanded' : 'collapsed') : 'leaf')

  return (
    <div
      class="ui-tree-row"
      role="treeitem"
      aria-level={props.depth + 1}
      aria-expanded={expandable() ? (expanded() ? 'true' : 'false') : undefined}
      aria-selected={props.selected === true ? 'true' : undefined}
      aria-disabled={props.disabled === true ? 'true' : undefined}
      data-depth={props.depth}
      data-kind={props.kind}
      data-link-kind={props.linkKind}
      data-cyclic={props.cyclic === true ? 'true' : undefined}
      data-disclosure={disclosure()}
      data-selected={props.selected === true ? 'true' : undefined}
      data-focused={props.focused === true ? 'true' : undefined}
      data-disabled={props.disabled === true ? 'true' : undefined}
      data-busy={props.busy === true ? 'true' : undefined}
      style={{ '--tree-row-depth': String(props.depth) }}
    >
      <Show when={expandable()}>
        <button
          type="button"
          class="ui-tree-row__disclosure"
          aria-expanded={expanded() ? 'true' : 'false'}
          aria-label={expanded() ? `Collapse ${props.name}` : `Expand ${props.name}`}
          disabled={props.busy === true || props.disabled === true}
          onClick={(e: MouseEvent) => props.onToggle?.(e)}
        >
          <span class="ui-tree-row__icon">
            <ChevronDownIcon />
          </span>
        </button>
      </Show>
      <span class="ui-tree-row__name" title={props.name}>
        {props.name}
      </span>
      <Show when={props.badge}>
        <span class="ui-tree-row__badge">{props.badge}</span>
      </Show>
    </div>
  )
}
