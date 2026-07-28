/**
 * MarkerList — an enumeration whose items each state a stance: this is included,
 * this is not, and here is a caveat about it.
 *
 * It exists because the export page had grown its own: `.st-export-manifest`,
 * `.st-export-carries`, `.st-export-omits`, `.st-export-check`, `.st-export-cross`
 * and `.st-export-note`, six surface classes re-declaring a type size, a colour
 * per stance and a glyph — for content that is the page's main reading matter. A
 * surface that declares its own type scale drifts from the kit's by exactly as
 * much as nobody notices, which is how that list ended up two steps below the
 * body text around it.
 *
 * The stance is the component's variance (`data-tone`), so the glyph and its
 * colour are decided once here rather than per caller. Callers pass text.
 *
 * Not a general-purpose `<ul>` wrapper: an ordinary bulleted list is ordinary
 * markup and does not need a component. This one has a vocabulary.
 */
import { For } from 'solid-js'

export type MarkerTone = 'included' | 'excluded' | 'note'

export interface MarkerListItem {
  text: string
  tone: MarkerTone
}

export interface MarkerListProps {
  items: MarkerListItem[]
}

/**
 * The glyph belongs to the tone, not to the caller. `−` is U+2212 MINUS SIGN,
 * not a hyphen: at the size this renders, a hyphen next to a `+` reads as dirt
 * on the screen rather than as the opposite of it.
 */
const MARKER: Record<MarkerTone, string> = {
  included: '+',
  excluded: '−',
  note: '',
}

export function MarkerList(props: MarkerListProps) {
  return (
    <ul class="ui-marker-list">
      <For each={props.items}>
        {(item) => (
          <li class="ui-marker-list__item" data-tone={item.tone}>
            <span class="ui-marker-list__marker" aria-hidden="true">
              {MARKER[item.tone]}
            </span>
            <span class="ui-marker-list__text">{item.text}</span>
          </li>
        )}
      </For>
    </ul>
  )
}
