/**
 * SearchField — a text input that looks like a search box: magnifier glyph
 * inside the field, on the leading edge.
 *
 * The icon lives in the component rather than in each caller's CSS, because a
 * search field without one is not a search field — it is a text box that
 * happens to filter, and every surface would otherwise have to remember to
 * draw the affordance itself.
 *
 * Justified by callers:
 * - settings.ts: st-search wrapper + st-search-input, type='text', placeholder, aria-label
 * - settings-content.ts: type='search' variant, st-search class on input
 */

import { SearchIcon } from './icons'

export interface SearchFieldProps {
  class?: string
  value: string
  onInput: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
}

export function SearchField(props: SearchFieldProps) {
  const onInput = (e: Event) => {
    const target = e.currentTarget as HTMLInputElement
    props.onInput(target.value)
  }

  return (
    <span class="ui-search-field">
      <span class="ui-search-field__icon">
        <SearchIcon />
      </span>
      <input
        type="search"
        class={props.class ?? ''}
        value={props.value}
        placeholder={props.placeholder ?? ''}
        aria-label={props.ariaLabel ?? undefined}
        disabled={props.disabled === true}
        onInput={onInput}
      />
    </span>
  )
}
