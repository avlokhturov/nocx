/**
 * FileStatusRow — one line of a Git panel list (design §5.4): a status
 * letter, a file-type icon, the path, and the stage/unstage control, composed
 * on the kit's CollectionRow in its dense variant (the row's home is the
 * sidebar).
 *
 * The one genuinely new thing this component owns is the status vocabulary:
 * the seven letters the wire can send and the tone each renders in. A surface
 * never supplies a glyph or a colour — it passes the wire's letter and this
 * module decides what that means, exactly as TreeRow decides its type glyphs.
 *
 * The letters are the wire's words: M modified, A added, D deleted, R
 * renamed, C copied, U unmerged, ? untracked. The tones are this module's
 * decision, one concept with one owner:
 *
 * - `A` and `?` are success — untracked renders as an addition, the way both
 *   reference products read it, because the user's question ("is this new to
 *   the repository?") has the same answer.
 * - `D` and `U` are danger — the file is gone, or unmergeable (the state the
 *   panel refuses to touch, design D19).
 * - `M` is warning — content changed in place.
 * - `R` and `C` are info — identity changed; the file is neither new nor
 *   gone, so they are not the addition tone.
 */
import { Show, createMemo, type JSX } from 'solid-js'
import { CollectionRow } from './collection-view'
import { FileIcon } from './icons'

/** The wire's one-letter status vocabulary (design §5.4). */
export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?'

/** The tone a status renders in — the component's decision, not a caller's.
 *  Deliberately NOT exported: an exported tone is a tone a surface can name,
 *  and naming it is one step from choosing it. */
type FileStatusTone = 'success' | 'warning' | 'danger' | 'info'

/** The glyph-and-tone table. The letter is the wire's word; the tone is
 *  owned here — see the module doc for why each letter maps where it does. */
const STATUS_TONE: Record<FileStatus, FileStatusTone> = {
  M: 'warning',
  A: 'success',
  '?': 'success',
  D: 'danger',
  U: 'danger',
  R: 'info',
  C: 'info',
}

export interface FileStatusRowProps {
  /** The repository path of the file, as the wire sent it. */
  path: string
  /** The wire's one-letter status. */
  status: FileStatus
  /** The caller's selection vocabulary — rendered, not decided. */
  selected?: boolean
  /** The current keyboard target; reads stronger than selection. */
  focused?: boolean
  /** Click/keyboard activation — opens the diff for this row. */
  onActivate?: (e: MouseEvent | KeyboardEvent) => void
  /** The stage/unstage control. A control here owns its click; activating
   *  it never activates the row. */
  actions?: JSX.Element
}

/** Split a repository path into the dimmed directory prefix and the name.
 *  A path ending in '/' (a directory row) has no name part and renders
 *  whole — a bare name at the root has no prefix at all. */
function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  if (slash < 0) return { dir: '', name: path }
  const name = path.slice(slash + 1)
  if (name === '') return { dir: '', name: path }
  return { dir: path.slice(0, slash + 1), name }
}

export function FileStatusRow(props: FileStatusRowProps) {
  // Memoized, not captured: props.path is reactive, and reading parts()
  // inside JSX below is what registers the dependency — a row re-rendered
  // with a different path must re-split it.
  const parts = createMemo(() => splitPath(props.path))
  // Rendered WITHOUT a wrapper element, deliberately. CollectionRow is the
  // row: it carries role="listitem", and a surface places these inside a
  // role="list" (connections.tsx:2470 is the existing example). A wrapping
  // div would sit between the two and orphan the listitem, because ARIA
  // requires a listitem to be owned by its list. The identity this component
  // adds therefore lives on its parts, which are uniquely named, and on the
  // row's own dense variant — not on a container that carries no appearance.
  return (
    <CollectionRow
      density="dense"
      selected={props.selected}
      focused={props.focused}
      onActivate={props.onActivate}
      info={
        <>
          <span class="ui-file-status-row__status" data-tone={STATUS_TONE[props.status]}>
            {props.status}
          </span>
          <span class="ui-file-status-row__type-icon" aria-hidden="true">
            <FileIcon />
          </span>
          <span class="ui-file-status-row__path" title={props.path}>
            <Show when={parts().dir}>
              <span class="ui-file-status-row__dir">{parts().dir}</span>
            </Show>
            <span class="ui-file-status-row__name">{parts().name}</span>
          </span>
        </>
      }
      actions={props.actions}
    />
  )
}
