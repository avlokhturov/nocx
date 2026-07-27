/**
 * Fixture: component with a root identity and a part identity.
 * Must detect `ui-fixture-rp` (root) and `ui-fixture-rp__element` (part).
 */
import type { JSX } from 'solid-js'
import { Show } from 'solid-js'

export interface RpProps {
  children: JSX.Element
  label?: string
}

export function RootAndPart(props: RpProps) {
  return (
    <div class="ui-fixture-rp">
      <Show when={props.label}>
        <span class="ui-fixture-rp__element">{props.label}</span>
      </Show>
      {props.children}
    </div>
  )
}
