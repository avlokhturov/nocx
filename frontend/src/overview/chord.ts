// The overview's chord: ⌥⌘O (Alt+Meta+O), bead nocx-edhcu — checked against
// the global chords rather than assumed: ⌘, (settings), ⌘B (sidebar), ⌘⇧P
// (palette), ⌘⇧O (ports), ⌥⌘P (snippets), ⌥⌘N (notes), ⌘T/⌘W/⌘1-9
// (PaneManager) and ⌘⇧. (the terminal's integration toggle). ⌥⌘O is free and
// sits in the ⌥⌘ family the other two document-level surfaces already use —
// which is the point: opening a transient full-window surface is one gesture,
// and the letter is what varies. O for Overview.
//
// ⌘⇧O is the PORTS view and is a different chord: shift, not option. The two
// are told apart by the modifier, and the predicate below is explicit about
// every modifier rather than merely requiring the ones it wants.
//
// The predicate is ONE thing, owned here, read by every keyboard boundary that
// needs it — the same shape snippets/chord.ts and notes/chord.ts have, and for
// the same reason: two derivations of "is this the chord" is how two
// boundaries start disagreeing about it (AD-8).
//
// Matched on `code`, not `key`: with Option held macOS reports the composed
// character (Option+O is ø on the US layout), so a key-based match would fail
// on exactly the layouts the chord is typed on.
export const OVERVIEW_CHORD_LABEL = '⌥⌘O'

export function isOverviewChord(e: KeyboardEvent): boolean {
  return (
    e.type === 'keydown' && e.altKey && e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyO'
  )
}
