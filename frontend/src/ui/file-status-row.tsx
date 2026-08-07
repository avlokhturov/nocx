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
  /** Lines added to this file on this side (git diff --numstat). Absent
   *  means no count exists — untracked, binary, conflicted, or a bounded
   *  count read (design D9) — and renders nothing, never `+0 −0`. The two
   *  arrive together or not at all; if one is absent both are treated as
   *  absent. */
  added?: number
  /** Lines deleted from this file on this side. Absent renders nothing. */
  deleted?: number
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
/** Split a repository path into the name and its dimmed directory.
 *  A path ending in '/' (a directory row) has no name part and renders
 *  whole — a bare name at the root has no directory at all.
 *
 *  The directory carries no trailing slash because it is rendered AFTER
 *  the name, not before it: `main.go` then `src/app`, which is how both
 *  reference products read a path in a narrow list. */
function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  if (slash < 0) return { dir: '', name: path }
  const name = path.slice(slash + 1)
  if (name === '') return { dir: '', name: path }
  return { dir: path.slice(0, slash), name }
}

export function FileStatusRow(props: FileStatusRowProps) {
  // Memoized, not captured: props.path is reactive, and reading parts()
  // inside JSX below is what registers the dependency — a row re-rendered
  // with a different path must re-split it.
  const parts = createMemo(() => splitPath(props.path))
  // The counts are a pair or nothing: the wire sends added and deleted
  // together (one numstat record), so a lone value is treated as absent —
  // absent means "no count exists", and rendering half a count would
  // invent a number the read never produced.
  const hasCounts = createMemo(() => props.added !== undefined && props.deleted !== undefined)
  // The wrapper goes INSIDE the info slot, and that placement is the whole
  // point (nocx-uf0p). It may not go outside CollectionRow: the row carries
  // role="listitem", a surface places these inside a role="list", and an
  // element between the two orphans the listitem, because ARIA requires a
  // listitem to be owned by its list. But the three parts still need a flex
  // container of their own — `.ui-collection-row__info` is a plain block and
  // must stay one, since the surfaces that stack a name over a meta line
  // inside it depend on that. Without this element the parts' flex-item
  // declarations address no flex parent and they lay out as inline content,
  // wrapping the path onto its own line and running it past the panel.
  return (
    <CollectionRow
      density="dense"
      selected={props.selected}
      focused={props.focused}
      onActivate={props.onActivate}
      info={
        <span class="ui-file-status-row">
          <span class="ui-file-status-row__status" data-tone={STATUS_TONE[props.status]}>
            {props.status}
          </span>
          <Show when={hasCounts()}>
            {/* The counts: +N −N, the answer to "how much did it change".
                The minus is U+2212, the glyph the reference source-control
                panels render; an ASCII hyphen reads as a dash in the same
                row as the plus. The tones are fixed by meaning — an
                addition is success, a removal danger — so unlike the
                status letter there is no tone table for a caller to name;
                the component owns it. The literal space keeps the two
                numbers readable in the DOM (the css gap alone would leave
                "+3−1" to a text assert). */}
            <span class="ui-file-status-row__counts" data-counts="present">
              <span class="ui-file-status-row__added">+{props.added}</span>{' '}
              <span class="ui-file-status-row__deleted">−{props.deleted}</span>
            </span>
          </Show>
          <span class="ui-file-status-row__type-icon" aria-hidden="true">
            <FileIcon />
          </span>
          {/* Name first, directory after it and dimmed — the order both
              reference products use, and the one that survives a sidebar.
              A path rendered as one string ellipsises at the tail, which
              is the file name, so twelve rows under one deep directory
              become twelve identical prefixes. Leading with the name means
              the part that answers "which file is this" is the last part
              to be given up. The whole path stays on the title. */}
          <span class="ui-file-status-row__path" title={props.path}>
            <span class="ui-file-status-row__name">{parts().name}</span>
            <Show when={parts().dir}>
              <span class="ui-file-status-row__dir">{parts().dir}</span>
            </Show>
          </span>
        </span>
      }
      actions={props.actions}
    />
  )
}
