// ═══════════════════════════════════════════════════════════════════════════
// Diff line decoration (git-manager §5.4) — the git diff surface's one
// decoration, on top of the ReadOnlyHost.
//
// The unified text is classified line by line; each classified line carries
// one class the surface's CSS colours and the tests key on:
//
//   git-diff-file   the file header block — `diff --git`, `index`, `---`, `+++`
//   git-diff-hunk   a hunk header — `@@ -1,3 +1,4 @@`
//   git-diff-add    an added line — `+` content
//   git-diff-del    a removed line — `-` content
//
// No syntax highlighting inside the diff — that is explicitly out of scope
// (design §4, its own bead), and a half-implementation that highlights
// additions but not context would be worse than none.
//
// The decorations are provided through a ViewPlugin's `decorations` option —
// the CM6 plugin-decoration mechanism — so this module never names the
// editor view or state classes. Construction and read-only enforcement
// belong to the ReadOnlyHost, one owner (design §5.4); the grep gate keeps
// that ownership visible.
// ═══════════════════════════════════════════════════════════════════════════

import { RangeSetBuilder, type Text } from '@codemirror/state'
import { Decoration, type DecorationSet, ViewPlugin } from '@codemirror/view'

/** The one class a unified line can carry, or null for context/plain lines. */
export type DiffLineClass = 'git-diff-file' | 'git-diff-hunk' | 'git-diff-add' | 'git-diff-del'

/**
 * Classify one line of unified diff text.
 *
 * The order is load-bearing: `+++`/`---` are file-header lines, not
 * additions/deletions, so they are checked BEFORE the single `+`/`-` tests —
 * a line starting `--- a/x` is the old-path header, while `-old` is a
 * deletion. `@@` hunk headers share no prefix with anything else.
 */
export function diffLineClass(text: string): DiffLineClass | null {
  if (text.startsWith('@@')) return 'git-diff-hunk'
  if (
    text.startsWith('diff --git ') ||
    text.startsWith('index ') ||
    text.startsWith('--- ') ||
    text.startsWith('+++ ')
  ) {
    return 'git-diff-file'
  }
  if (text.startsWith('+')) return 'git-diff-add'
  if (text.startsWith('-')) return 'git-diff-del'
  return null
}

/** Line decorations for the whole document, rebuilt whenever the doc changes. */
function buildDecorations(doc: Text): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const cls = diffLineClass(line.text)
    if (cls) {
      builder.add(line.from, line.from, Decoration.line({ attributes: { class: cls } }))
    }
  }
  return builder.finish()
}

/** One stateful value per view; the decorations option feeds the editor. */
class DiffDecorationPlugin {
  decorations: DecorationSet

  constructor(view: { state: { doc: Text } }) {
    this.decorations = buildDecorations(view.state.doc)
  }

  update(update: { docChanged: boolean; state: { doc: Text } }): void {
    if (update.docChanged) this.decorations = buildDecorations(update.state.doc)
  }
}

/** The extension the diff surface hands to the host. */
export const gitDiffDecoration = ViewPlugin.fromClass(DiffDecorationPlugin, {
  decorations: (plugin) => plugin.decorations,
})
