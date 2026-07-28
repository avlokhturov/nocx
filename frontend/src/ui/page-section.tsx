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
 * defect it is, and fixed last because nothing styled it and so nothing broke.
 *
 * There is no `class` passthrough. §3.6 originally kept one on the structural
 * containers, bounded to layout and enforced by rule 11's weak tier — and that tier
 * was then refused because it fires on ordinary cards, which left the bound written
 * down and unchecked. Measured before removing it: the only caller passing a class to
 * any structural container was export-section, whose `st-export-card` had no CSS at
 * all and existed as a test hook. A prop with no consumer and no enforceable bound is
 * the hatch this epic exists to close, and a type that refuses it beats a lint rule
 * that cannot see it. Placement belongs to the parent's own selector, which rule 3
 * permits (nocx-zeti).
 */

import type { JSX } from 'solid-js'

export interface PageSectionProps {
  id?: string
  title: string
  children: JSX.Element
}

export function PageSection(props: PageSectionProps) {
  return (
    <section id={props.id} class="ui-page-section">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  )
}
