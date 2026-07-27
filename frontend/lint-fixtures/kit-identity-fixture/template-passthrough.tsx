/**
 * Fixture: template literal with passthrough. Must detect `ui-fixture-tmpl`.
 */
export interface TpProps {
  class?: string
}

export function TemplatePassthrough(props: TpProps) {
  return <div class={`ui-fixture-tmpl ${props.class ?? ''}`.trim()}>tmpl</div>
}
