/**
 * Section — titled grouping of controls or content in a view.
 *
 * Justified by callers:
 * - settings.ts: div.st-section > h2.st-section-heading + rows
 * - connections.ts: div.cm-form-section > h2 + fields
 * - export-section.ts: div.st-export wrapper with heading + description
 *
 * No `class` passthrough — see page-section.tsx for why the structural containers
 * stopped accepting one.
 */

import type { JSX } from 'solid-js'
export interface SectionProps {
  id?: string
  title: string
  children: JSX.Element
}

export function Section(props: SectionProps) {
  return (
    <section id={props.id} class="ui-section">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  )
}
