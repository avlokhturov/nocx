// The notes chord: ⌥⌘N (Alt+Meta+N), design §6.3 — checked against the
// global chords rather than assumed: ⌘, (settings), ⌘⇧P (palette), ⌥⌘P
// (snippets), ⌘⇧O (ports), ⌘T/⌘W/⌘1-9 (TabManager). ⌥⌘N is free and sits
// beside the snippets chord it is a sibling of.
//
// The predicate is ONE thing, owned here, read by every keyboard boundary
// that needs it — the same shape snippets/chord.ts has, and for the same
// reason: two derivations of "is this the chord" is how two boundaries
// start disagreeing about it (AD-8).
//
// Matched on `code`, not `key`: with Option held, macOS reports the
// composed character (Option+N is a dead key for the tilde on the US
// layout), so a key-based match would fail on exactly the layouts the chord
// is typed on.
export const NOTE_CHORD_LABEL = '⌥⌘N'

export function isNoteChord(e: KeyboardEvent): boolean {
  return (
    e.type === 'keydown' && e.altKey && e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyN'
  )
}
