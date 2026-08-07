// ═══════════════════════════════════════════════════════════════════════════
// ReadOnlyHost — the reusable read-only CodeMirror 6 host (git-manager §5.4).
//
// One owner for everything a read-only surface needs from CM6: EditorView
// construction, read-only enforcement, and the base theme. A caller brings
// its own extensions — language selection, highlighting, decorations — and
// the host appends them AFTER its own. The host's facets come first in the
// extension array, and CM6 resolves facets by precedence with the first
// value winning, so a caller extension can never re-enable editing.
//
// The host renders no chrome: the caller creates the parent element and owns
// everything around it (notices, banners, diff decoration). The file viewer
// and the git diff surface share this module; neither constructs an
// EditorView itself.
//
// Lifecycle: mount() constructs and attaches the view and arms the given
// AbortSignal; dispose() destroys the view and is idempotent. Abort-driven
// disposal is the host's job, independent of whatever the caller does on its
// own dispose path — a surface that forgets to tear down cannot leak a live
// view when its tab dies.
// ═══════════════════════════════════════════════════════════════════════════

import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** CM6 look: colours only, resolved through the app's --color-* tokens so a
 *  theme switch recolours every host surface (ADR-0013). Layout lives in
 *  CSS. The diff surface inherits this by construction — it is the host's
 *  base theme, not a per-surface choice. */
const baseTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--color-canvas)',
    color: 'var(--color-text)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { caretColor: 'transparent' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-canvas)',
    color: 'var(--color-text-dim)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'var(--color-surface-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-surface-hover)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--color-surface-active)',
  },
})

export class ReadOnlyHost {
  private view: EditorView | null = null
  private disposed = false
  private abortSignal: AbortSignal | null = null
  /** Bound once so dispose() can detach it; a late abort is then a no-op. */
  private readonly onAbort = (): void => this.dispose()

  /**
   * Construct and mount the view into `parent`, with the caller's extensions
   * appended after the host's own (read-only enforcement + base theme). The
   * host never inspects the caller's extensions.
   *
   * The view is destroyed when `signal` aborts; a signal that was ALREADY
   * aborted before this call mounts nothing. Call at most once per host —
   * a second mount throws.
   */
  mount(parent: HTMLElement, signal: AbortSignal, extensions: Extension[] = []): void {
    if (this.disposed) return
    if (this.view) {
      throw new Error('nocx: ReadOnlyHost.mount called twice on one host')
    }
    if (signal.aborted) {
      this.disposed = true
      return
    }
    this.abortSignal = signal
    this.view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          baseTheme,
          ...extensions,
        ],
      }),
      parent,
    })
    signal.addEventListener('abort', this.onAbort, { once: true })
  }

  /** Replace the whole document. Read-only is an input gate; the host may
   *  still paint content — the wire's bytes are the only writer. */
  setDoc(text: string): void {
    const view = this.view
    if (!view) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  }

  /** Focus the content. Inert before mount or after dispose. */
  focus(): void {
    this.view?.focus()
  }

  /** Destroy the view and detach from the abort signal. Idempotent; safe to
   *  call after the signal already fired, and vice versa. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abortSignal?.removeEventListener('abort', this.onAbort)
    this.abortSignal = null
    this.view?.destroy()
    this.view = null
  }
}
