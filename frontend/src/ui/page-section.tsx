/**
 * PageSection — a titled section within a Page, with an optional anchor id
 * for deep linking. Uses `<section>` for semantics.
 *
 * Overlaps with the existing `Section` component (same h2+children pattern)
 * but differs in:
 * - Uses `<section>` not `<div>`
 * - Has `id` for anchor-based scroll targeting
 * - Gets page-specific spacing from surface.css
 *
 * They are deliberately not merged; the coordinator decides.
 *
 * `ui-page-section` is not optional. This component was the last one in the kit still
 * emitting only its caller's class — named in §1 of the migration design as the
 * defect it is, and fixed last because nothing styled it and so nothing broke. A
 * structural container keeps its `class` passthrough (§3.6), bounded to layout, but
 * the identity comes first: a component named only by its consumer is a component the
 * consumer owns.
 */

import type { JSX } from 'solid-js'

export interface PageSectionProps {
  id?: string
  title: string
  class?: string
  children: JSX.Element
}

export function PageSection(props: PageSectionProps) {
  return (
    <section id={props.id} class={`ui-page-section ${props.class ?? ''}`.trim()}>
      <h2>{props.title}</h2>
      {props.children}
    </section>
  )
}
