// The colours a tab can be given (nocx-isoph.4, design §4.5).
//
// A KEY, NOT A HEX. The wire bounds the colour as "a token like '#ff8800' or
// a theme key", and the key is what this application stores: a tab coloured
// under one theme must still read under another, and a stored #ff8800 is a
// value that was chosen against a palette the user may have left. The key
// resolves in tab.css to a token every one of the twelve shipped themes
// defines, so the tab follows the theme instead of fighting it.
//
// FOUR, and the set is closed for the same reason the pane kinds are: every
// theme defines exactly these four accents, so a fifth would be a colour that
// exists in some themes and not others — which is a tab that loses its colour
// when you change theme.

/** The stored value of a coloured tab. `null` is an undecorated tab, which is
 *  the normal state and not a fifth colour. */
export type TabColour = 'green' | 'amber' | 'red' | 'violet'

export interface TabColourChoice {
  readonly key: TabColour
  /** What the menu row says. A colour word rather than the token's role
   *  ('success', 'danger'): the user is choosing a colour, and the roles are
   *  the kit's vocabulary, not theirs. */
  readonly label: string
}

export const TAB_COLOURS: readonly TabColourChoice[] = [
  { key: 'green', label: 'Green' },
  { key: 'amber', label: 'Amber' },
  { key: 'red', label: 'Red' },
  { key: 'violet', label: 'Violet' },
]

/** Whether a stored value is one this renderer can draw. A colour it does not
 *  recognise renders as no colour rather than as a broken swatch — the store
 *  is the owner of what is stored, and an unknown value is a fact about a
 *  newer or older renderer, not a reason to refuse to draw the strip. */
export function isTabColour(value: string | null): value is TabColour {
  return value !== null && TAB_COLOURS.some((c) => c.key === value)
}
