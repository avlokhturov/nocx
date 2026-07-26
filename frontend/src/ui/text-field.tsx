/**
 * TextField — text, number, or password input.
 *
 * Justified by callers:
 * - settings.ts: input[type=text] and input[type=number] with change event, min/max
 * - connections.ts: inputField() / textField() / numberField() — label + input with input event
 */

import { Show } from 'solid-js'

export interface TextFieldProps {
  class?: string
  label?: string
  value: string | number
  /** Fires on every keystroke (input event). */
  onInput?: (value: string) => void
  type?: 'text' | 'number' | 'password'
  placeholder?: string
  min?: number
  max?: number
}

export function TextField(props: TextFieldProps) {
  const onInput = (e: Event) => {
    const target = e.currentTarget as HTMLInputElement
    props.onInput?.(target.value)
  }

  return (
    <div class={props.class ?? ''}>
      <Show when={props.label !== undefined}>
        <label>{props.label}</label>
      </Show>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder ?? ''}
        min={props.min !== undefined ? String(props.min) : undefined}
        max={props.max !== undefined ? String(props.max) : undefined}
        onInput={onInput}
      />
    </div>
  )
}
