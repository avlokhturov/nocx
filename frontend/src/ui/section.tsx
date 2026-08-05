/**
 * Section — titled grouping of controls or content in a view.
 *
 * Justified by callers:
 * - settings.ts: div.st-section > h2.st-section-heading + rows
 * - connections.ts: div.cm-form-section > h2 + fields
 * - export-section.ts: div.st-export wrapper with heading + description
 *
 * Children are spaced by the Stack primitive (one source of truth for vertical
 * rhythm). No `class` passthrough — see page-section.tsx for why the structural
 * containers stopped accepting one.
 */
import type { JSX } from 'solid-js'
import { Stack } from './stack'

export interface SectionProps {
  id?: string
  title: string
  /** When true, forwards to the inner Stack to draw separators between children. */
  divided?: boolean
  /** Forwards the Stack's dense rhythm — a scanned list rather than a read form. */
  dense?: boolean
  children: JSX.Element
}

export function Section(props: SectionProps) {
  return (
    <section id={props.id} class="ui-section" data-dense={props.dense ? 'true' : undefined}>
      <h2>{props.title}</h2>
      <Stack gap="default" divided={props.divided} dense={props.dense}>
        {props.children}
      </Stack>
    </section>
  )
}
