// The tab's label is COMPUTED, never stored (design §4.5, nocx-isoph.4).
//
// A tab created by a DRAG was never named by anybody, so demanding a name
// asks for something the user did not give. Its identity is its panes, so
// their titles are its label — `nocx · srv-01 · claude`. A name the user DOES
// type is stored on the tab and wins.
//
// THE LABEL FLOWS PANE → TAB, which only works because a pane is named by
// what is in it: the program's own title (OSC 0/2), else the command running
// in the foreground, else the pane's cwd (nocx-n8n82, composed in
// terminal-content.ts). This module is the second half of that sentence and
// nothing more — it takes titles and gives back one string.
//
// ELISION IS THE STRIP'S, NOT THIS FUNCTION'S. "Elided to the available
// width" is a measurement, and the width lives in CSS; the tab row already
// ellipsises its title. A character budget here would be a second, wrong
// answer to a question the layout already answers, and it would be wrong at a
// different zoom level.

/** The separator between two panes' titles in one label. A middle dot with
 *  spaces, the same glyph the update notice and the footprint section use for
 *  "these are separate facts about one thing". Not exported: the string is an
 *  implementation detail of the label, and a test that asserted it through a
 *  constant would be asserting nothing. */
const TITLE_SEPARATOR = ' · '

/**
 * The label for one tab.
 *
 * `name` is what the user typed, or null when nobody named it — the normal
 * case. `paneTitles` are its panes' titles, in the order the panes are shown.
 *
 * Returns '' when there is nothing to say yet: a pane one round trip old has
 * no title, and an empty string is honest where a placeholder would print a
 * word that is never the answer and then replace it (nocx-83a).
 */
export function tabLabel(name: string | null, paneTitles: readonly string[]): string {
  const typed = (name ?? '').trim()
  if (typed !== '') return typed
  return paneTitles
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .join(TITLE_SEPARATOR)
}
