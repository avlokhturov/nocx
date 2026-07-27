/**
 * Field — label + description + error + control wrapper for form rows.
 *
 * Each form control (TextField, Select, Checkbox, etc.) inside a Field
 * gets its id from the `for` prop so label, description and error are
 * linked via `for` and `aria-describedby`.
 *
 * Justified by callers:
 * - connections.ts: div.cm-field > label + input (credential selector, jump host)
 * - settings.ts: st-control-col > label + select/input (all setting rows)
 * - export-section.ts: label + input pairs
 *
 * Every form row should use this instead of ad-hoc markup.
 */

import type { JSX } from 'solid-js'
import { Show } from 'solid-js'

export interface FieldProps {
  class?: string
  /** The id of the control inside this field — used for label's `for` and
   *  description/error aria-describedby wiring. */
  for: string
  label: string
  description?: string
  error?: string
  required?: boolean
  children: JSX.Element
}

export function Field(props: FieldProps) {
  const descriptionId = () => (props.description ? `${props.for}__desc` : undefined)
  const errorId = () => (props.error ? `${props.for}__error` : undefined)

  return (
    <div class={props.class ?? ''}>
      <label for={props.for}>
        {props.label}
        <Show when={props.required === true}>
          <span aria-hidden="true"> *</span>
        </Show>
      </label>
      <Show when={props.description !== undefined}>
        <p id={descriptionId()} class="ui-field-desc">
          {props.description}
        </p>
      </Show>
      {props.children}
      <Show when={props.error !== undefined}>
        <p id={errorId()} class="ui-field-error" role="alert">
          {props.error}
        </p>
      </Show>
    </div>
  )
}
