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
import { Show } from 'solid-js'
import { Field } from './field'

export interface TextFieldProps {
  id?: string
  label?: string
  description?: string
  error?: string
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
  type?: 'text' | 'number' | 'password'
  placeholder?: string
  min?: number
  max?: number
  disabled?: boolean
  required?: boolean
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

  const input = () => (
    <input
      class="ui-text-field__input"
      id={inputId() || undefined}
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder ?? ''}
      min={props.min !== undefined ? String(props.min) : undefined}
      max={props.max !== undefined ? String(props.max) : undefined}
      disabled={props.disabled === true}
      required={props.required === true}
      aria-invalid={props.error !== undefined ? true : undefined}
      aria-describedby={ariaDescribedBy()}
      onInput={onInput}
      onBlur={onBlur}
    />
  )

  const hasFieldContent = () =>
    props.label !== undefined ||
    props.description !== undefined ||
    props.error !== undefined ||
    props.required === true

  return (
    <div class="ui-text-field">
      <Show when={hasFieldContent()} fallback={input()}>
        <Field
          for={inputId()}
          label={props.label}
          description={props.description}
          error={props.error}
          required={props.required}
        >
          {input()}
        </Field>
      </Show>
    </div>
  )
}
