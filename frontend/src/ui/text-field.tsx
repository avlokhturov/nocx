/**
 * TextField — text, number, or password input.
 *
 * Composes Field for label, description, error, and required marker.
 * Only the input and its event wiring live here.
 *
 * Justified by callers:
 * - settings.ts: input[type=text] and input[type=number] with change event, min/max
 * - connections.ts: inputField() / textField() / numberField() — label + input with input event
 */
import { For, Show, Switch, Match, createEffect, type JSX } from 'solid-js'
import { Field } from './field'

export interface TextFieldProps {
  id?: string
  label?: string
  description?: string
  error?: string
  /** When true, renders a <textarea> instead of an <input>. */
  multiline?: boolean
  value: string | number
  /** Fires on every keystroke (input event). */
  onInput?: (value: string) => void
  /**
   * Fires when focus leaves the input.
   *
   * Exists for validation: a message must not appear while the user is still
   * typing the first character of an empty field, so `createFormValidation` marks
   * a field answered on blur rather than on input. See `ui/validation.ts`.
   */
  onBlur?: (value: string) => void
  /**
   * Fires when the control takes focus. Exists for fields whose suggestions
   * are DISCOVERED rather than known: focus is the moment a person is about
   * to need them, and the cheapest honest place to go and look.
   */
  onFocus?: () => void
  type?: 'text' | 'number' | 'password'
  /**
   * Values to offer as suggestions, through a native `<datalist>`. The field
   * stays FREE TEXT: a suggestion is an addition, never a gate, so a value
   * the list does not contain is still typeable and still submitted. Use it
   * where the set is discovered rather than fixed — the AI endpoint's models
   * come from the endpoint itself, and an endpoint that lists none must stay
   * configurable by hand. A field whose set is closed wants a Select, not
   * this. Requires `id`; without one there is nothing to point `list` at.
   */
  suggestions?: readonly string[]
  placeholder?: string
  min?: number
  max?: number
  disabled?: boolean
  required?: boolean
  autoFocus?: boolean
  trailing?: JSX.Element
  /**
   * A numeric field's unit ('days', 'MiB'), rendered as a suffix inside the
   * control so the number and its unit read — and copy — as one thing.
   * Declared by the setting's NumberSpec, never invented by a screen.
   */
  unit?: string
  /**
   * A permanent caption beneath the control — a number field's allowed
   * range. When `error` is present it REPLACES the caption in this same
   * single-line slot, so the layout does not jump and the two never
   * compete. Without a caption the error renders through Field as before.
   */
  caption?: string
  /**
   * Which edge the caption is flush with — 'start' (the default) or 'end'.
   *
   * It follows the column the field sits in, not the field: on a settings
   * page the controls are pinned to the right of the row, so captions set
   * 'start' leave a ragged right edge down the whole section, while 'end'
   * lines every one of them up with the fields above and below it.
   */
  captionAlign?: 'start' | 'end'
}

export function TextField(props: TextFieldProps) {
  const inputId = () => props.id ?? ''
  const descriptionId = () => (props.description ? `${inputId()}__desc` : undefined)
  const errorId = () => (props.error ? `${inputId()}__error` : undefined)
  const ariaDescribedBy = () => [descriptionId(), errorId()].filter(Boolean).join(' ') || undefined

  const onInput = (e: Event) => {
    const target = e.currentTarget as HTMLInputElement
    props.onInput?.(target.value)
  }

  const onBlur = (e: FocusEvent) => {
    const target = e.currentTarget as HTMLInputElement
    props.onBlur?.(target.value)
  }

  const inputElement = () => (
    <input
      class="ui-text-field__input"
      id={inputId() || undefined}
      type={props.type ?? 'text'}
      placeholder={props.placeholder ?? ''}
      min={props.min !== undefined ? String(props.min) : undefined}
      max={props.max !== undefined ? String(props.max) : undefined}
      disabled={props.disabled === true}
      required={props.required === true}
      aria-invalid={props.error !== undefined ? true : undefined}
      aria-describedby={ariaDescribedBy()}
      autofocus={props.autoFocus === true}
      list={suggestionsId()}
      ref={(element) => {
        if (props.autoFocus === true) queueMicrotask(() => element.focus())
        mirrorValue(element)
      }}
      onInput={onInput}
      onBlur={onBlur}
      onFocus={() => props.onFocus?.()}
    />
  )

  /**
   * Mirror `props.value` into the element, and ONLY when it differs from what
   * the element already holds.
   *
   * A plain `value={props.value}` writes on every change — including the
   * change the user's own keystroke just caused, where the element already
   * holds exactly that string. The redundant write is not free: assigning
   * `input.value` closes an open `<datalist>` popup, so a suggestion list
   * shut itself on every letter typed, which is the opposite of what a
   * suggestion list is for. Guarding the write is also correct on its own
   * terms — a controlled input should not fight the caret it is not moving.
   */
  function mirrorValue(element: HTMLInputElement) {
    createEffect(() => {
      const next = String(props.value)
      if (element.value !== next) element.value = next
    })
  }

  /** The datalist's id, or undefined when there is nothing to suggest. */
  const suggestionsId = () =>
    props.suggestions !== undefined && props.suggestions.length > 0 && inputId() !== ''
      ? `${inputId()}-suggestions`
      : undefined

  const suggestionList = () => (
    <Show when={suggestionsId()}>
      <datalist id={suggestionsId()}>
        <For each={props.suggestions}>{(s) => <option value={s} />}</For>
      </datalist>
    </Show>
  )

  const textareaElement = () => (
    <textarea
      class="ui-text-field__input"
      id={inputId() || undefined}
      value={props.value}
      placeholder={props.placeholder ?? ''}
      disabled={props.disabled === true}
      required={props.required === true}
      aria-invalid={props.error !== undefined ? true : undefined}
      aria-describedby={ariaDescribedBy()}
      autofocus={props.autoFocus === true}
      rows={4}
      ref={(element) => {
        if (props.autoFocus === true) queueMicrotask(() => element.focus())
      }}
      onInput={onInput}
      onBlur={onBlur}
    />
  )

  const input = () => (
    <>
      <div
        class="ui-text-field__control"
        data-trailing={props.trailing !== undefined ? 'true' : 'false'}
        data-unit={props.unit !== undefined && props.multiline !== true ? 'true' : undefined}
      >
        <Switch>
          <Match when={props.multiline === true}>{textareaElement()}</Match>
          <Match when={true}>{inputElement()}</Match>
        </Switch>
        {suggestionList()}
        <Show when={!props.multiline && props.trailing}>
          <span class="ui-text-field__trailing">{props.trailing}</span>
        </Show>
        <Show when={!props.multiline && props.unit !== undefined}>
          <span class="ui-text-field__unit">{props.unit}</span>
        </Show>
      </div>
      {/* One caption slot beneath the control: the permanent caption, or the
          error in its place — never both, never a second line, so the field's
          height does not change when a value goes out of range. */}
      <Show when={props.caption !== undefined}>
        <p
          class="ui-text-field__caption"
          data-align={props.captionAlign ?? 'start'}
          data-tone={props.error !== undefined ? 'error' : 'caption'}
          role={props.error !== undefined ? 'alert' : undefined}
        >
          {props.error ?? props.caption}
        </p>
      </Show>
    </>
  )

  // Whether Field has anything to draw around the control. An error counts
  // ONLY when there is no caption slot to put it in: with a caption the error
  // is rendered in that slot, so letting it pull in a Field wrapper would
  // change the DOM — and the height — the moment a value went out of range.
  // Measured in a real browser on 2026-08-01: the wrapper appearing on error
  // grew a bare number field from 48.7px to 52.7px, and the row under it
  // shifted, which is exactly what the single caption slot exists to prevent.
  const hasFieldContent = () =>
    props.label !== undefined ||
    props.description !== undefined ||
    (props.error !== undefined && props.caption === undefined) ||
    props.required === true

  return (
    <div class="ui-text-field" data-multiline={props.multiline ? 'true' : undefined}>
      <Show when={hasFieldContent()} fallback={input()}>
        {/* When a caption slot exists it OWNS the error (the error replaces the
            caption in that slot); Field must not render a second one. */}
        <Field
          for={inputId()}
          label={props.label}
          description={props.description}
          error={props.caption !== undefined ? undefined : props.error}
          required={props.required}
        >
          {input()}
        </Field>
      </Show>
    </div>
  )
}
