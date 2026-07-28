/**
 * PageBody — the flex row that holds the rail and the scroller.
 * Renders `.ui-page__body`.
 *
 * Typically composed inside Page rather than used directly; exported for
 * custom page layouts that need explicit control over the rail/scroller
 * arrangement.
 */

import type { JSX } from 'solid-js'

export interface PageBodyProps {
  children: JSX.Element
  /** Page needs the element to place focus into after a page change (§3.8). */
  ref?: (el: HTMLDivElement) => void
}

export function PageBody(props: PageBodyProps) {
  return (
    <div class="ui-page__body" ref={props.ref}>
      {props.children}
    </div>
  )
}
