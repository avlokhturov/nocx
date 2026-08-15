/**
 * SuggestionField — a free-text field that offers suggestions (fix-kit-rowlist).
 *
 * The kit's replacement for the native `<datalist>`: a text input whose
 * suggestions render as OUR list, not the platform's. What was wrong with
 * the datalist was ownership — its type, spacing and colours were the
 * browser's, and its lifecycle was not ours (it closed on the very write
 * that carried the keystroke, which is what the guarded value mirror in
 * controlled-value.ts exists to hold closed).
 *
 * The contract:
 *
 * - FREE TEXT always. A suggestion is an addition, never a gate: a value
 *   the list does not contain is typeable and submitted exactly as one the
 *   list offers. The endpoint's models are discovered from the endpoint,
 *   and an endpoint that lists none — GET /models is not universally
 *   implemented — must stay configurable by hand. The list only ever
 *   narrows what is offered; it never refuses a value.
 * - Keyboard first: Up/Down move the active option, Enter takes it,
 *   Escape dismisses the list without losing what was typed, and typing
 *   keeps filtering — the list never closes on the input that fills it.
 *   It is a combobox, and it carries the ARIA a combobox needs
 *   (`role="combobox"` + `aria-expanded`/`aria-controls`/
 *   `aria-activedescendant` on the input, `listbox`/`option` on the list).
 * - The list is the caller's to fill, the component's to filter: a prefix
 *   match on the current value (empty value offers everything), so the
 *   caller passes the discovered set and the component decides what to
 *   show. The first match follows the typed value, so Enter takes what the
 *   user is looking at.
 *
 * Composes Field for label/description/error/required exactly like
 * TextField; the input wears its own identity (`ui-suggestion-field__input`)
 * and repeats the base input token references text-field.css carries —
 * kit.css styled all input types from one selector list and the T1 split
 * gives each primitive its own (search-field.css says the same).
 */
import { For, createEffect, createSignal, on } from 'solid-js'
import { Field } from './field'
import { mirrorControlledValue } from './controlled-value'

export interface SuggestionFieldProps {
  id?: string
  label?: string
  description?: string
  error?: string
  value: string
  /** Fires on every keystroke AND when a suggestion is taken. */
  onInput?: (value: string) => void
  /** Fires when focus leaves the input, with the current value. */
  onBlur?: (value: string) => void
  /** Fires when the control takes focus. Suggestions are DISCOVERED rather
   *  than known: focus is the moment a person is about to need them, and the
   *  cheapest honest place to go and look. */
  onFocus?: () => void
  /**
   * The values to OFFER. The component filters them by the current value
   * (prefix match); passing the raw discovered set is the whole API. Free
   * text still: the list narrows what is offered, never what is accepted.
   */
  suggestions?: readonly string[]
  placeholder?: string
  disabled?: boolean
  required?: boolean
}

export function SuggestionField(props: SuggestionFieldProps) {
  const inputId = () => props.id ?? ''
  const listId = () => `${inputId()}-suggestions`
  const descriptionId = () => (props.description ? `${inputId()}__desc` : undefined)
  const errorId = () => (props.error ? `${inputId()}__error` : undefined)
  const ariaDescribedBy = () => [descriptionId(), errorId()].filter(Boolean).join(' ') || undefined

  const [open, setOpen] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  const [active, setActive] = createSignal(-1)

  /** Prefix match on the typed value; an empty value offers everything. */
  const filtered = () => {
    const q = String(props.value).trim().toLowerCase()
    const all = props.suggestions ?? []
    if (q === '') return all
    return all.filter((s) => s.toLowerCase().startsWith(q))
  }

  /** The popup is expanded only when there is something to show. */
  const expanded = () => open() && filtered().length > 0

  /**
   * Suggestions can arrive AFTER focus — the caller discovers them over the
   * wire, and there is no list yet at the moment of focus. Open the moment
   * they land; the person who focused the field is waiting for them.
   *
   * `on` fires only when the COUNT changed, and only a 0 → n transition is
   * an arrival: closing the list (take, Escape) changes no suggestion count,
   * so a list the user just closed stays closed.
   */
  createEffect(
    on(
      () => props.suggestions?.length ?? 0,
      (n, prev) => {
        if (prev === 0 && n > 0 && focused() && !open()) setOpen(true)
      },
    ),
  )

  /**
   * The first match follows the typed value: Enter takes what the user is
   * looking at, and a filter that matches nothing clears the highlight.
   * Tracked on the VALUE (the filter's source), never on open/active: merely
   * opening the list highlights nothing — the user has not chosen yet — and
   * an explicit close is not undone.
   */
  createEffect(
    on(
      () => String(props.value),
      () => {
        if (!expanded()) return
        const n = filtered().length
        const a = active()
        setActive(n === 0 ? -1 : a >= n ? n - 1 : a < 0 ? 0 : a)
      },
    ),
  )

  const onInput = (e: Event) => {
    const value = (e.currentTarget as HTMLInputElement).value
    props.onInput?.(value)
    // Typing never closes the list — it re-filters it. This is the exact
    // defect being replaced: the datalist shut itself on the keystroke.
    setOpen(true)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const n = filtered().length
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (!expanded()) {
          setOpen(true)
          setActive(n > 0 ? 0 : -1)
        } else {
          setActive(Math.min(active() + 1, n - 1))
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        if (!expanded()) {
          setOpen(true)
          setActive(n > 0 ? n - 1 : -1)
        } else {
          const a = active()
          // From nothing active, Up lands on the LAST option; from the top
          // it clamps rather than wrapping.
          setActive(a < 0 ? n - 1 : a === 0 ? 0 : a - 1)
        }
        break
      case 'Enter': {
        const a = active()
        if (expanded() && a >= 0 && a < n) {
          e.preventDefault()
          take(filtered()[a])
        }
        break
      }
      case 'Escape':
        if (expanded()) {
          // Dismiss the list, never the dialog it sits in, and never what
          // was typed: the value is untouched and focus stays in the input.
          e.preventDefault()
          e.stopPropagation()
          setOpen(false)
          setActive(-1)
        }
        break
    }
  }

  /** Take a suggestion through the SAME channel as typing — onInput — so
   *  the caller treats a pick exactly like the value it replaced. */
  const take = (value: string) => {
    props.onInput?.(value)
    setOpen(false)
    setActive(-1)
  }

  const onBlur = (e: FocusEvent) => {
    setFocused(false)
    setOpen(false)
    setActive(-1)
    props.onBlur?.((e.currentTarget as HTMLInputElement).value)
  }

  const optionId = (index: number) => `${listId()}-option-${index}`

  return (
    <div class="ui-suggestion-field">
      <Field
        for={inputId()}
        label={props.label}
        description={props.description}
        error={props.error}
        required={props.required}
      >
        <div class="ui-suggestion-field__control">
          <input
            class="ui-suggestion-field__input"
            id={inputId() || undefined}
            role="combobox"
            aria-expanded={expanded()}
            aria-controls={listId()}
            aria-autocomplete="list"
            aria-activedescendant={expanded() && active() >= 0 ? optionId(active()) : undefined}
            aria-invalid={props.error !== undefined ? true : undefined}
            aria-describedby={ariaDescribedBy()}
            placeholder={props.placeholder ?? ''}
            disabled={props.disabled === true}
            required={props.required === true}
            // mirrorControlledValue reads the accessor inside its own createEffect
            // (a tracked scope); the gate cannot see across that helper boundary.
            // eslint-disable-next-line solid/reactivity -- helper-boundary contract
            ref={(element) => mirrorControlledValue(element, () => props.value)}
            onInput={onInput}
            onKeyDown={onKeyDown}
            onFocus={() => {
              setFocused(true)
              setOpen((props.suggestions?.length ?? 0) > 0)
              props.onFocus?.()
            }}
            onBlur={onBlur}
          />
          <ul id={listId()} role="listbox" class="ui-suggestion-field__list" hidden={!expanded()}>
            <For each={filtered()}>
              {(s, i) => (
                <li
                  id={optionId(i())}
                  role="option"
                  aria-selected={active() === i()}
                  class="ui-suggestion-field__option"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => take(s)}
                  onMouseEnter={() => setActive(i())}
                >
                  {s}
                </li>
              )}
            </For>
          </ul>
        </div>
      </Field>
    </div>
  )
}
