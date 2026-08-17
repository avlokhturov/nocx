// The snippet palette's chord: ⌥⌘P (Alt+Meta+P), design §10.1 — checked
// against the global chords rather than assumed: ⌘, (settings), ⌘⇧P
// (quick-connect — TAKEN), ⌘⇧O (ports), ⌘T/⌘W/⌘1-9 (PaneManager). ⌥⌘P is
// free and matches termic's palette.
//
// The predicate is ONE thing, owned here, read by both keyboard boundaries
// — xterm's custom key handler (renderers/xterm.ts) and the editor's
// arbiter chain (terminal-content.ts) — which then delegate to the SAME
// opener (AD-8: one owner per behaviour). A second derivation of "is this
// the chord" would be how the two boundaries start disagreeing about it.
//
// Matched on `code`, not `key`: with Option held, macOS reports the
// composed character (Option+P = 'π' on the US layout), so a key-based
// match would fail on exactly the layouts the chord is typed on. `code` is
// the physical key and is layout-independent.
export const SNIPPET_CHORD_LABEL = '⌥⌘P'

export function isSnippetChord(e: KeyboardEvent): boolean {
  return (
    e.type === 'keydown' && e.altKey && e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyP'
  )
}
