/**
 * Button — the terminal's action affordance.
 *
 * Justified by callers:
 * - settings.ts: st-retry-btn, st-secret-replace/clear, st-reset-btn
 * - connections.ts: cm-primary/new, cm-save, cm-connect, cm-danger, cm-quick-connect, plain toolbar buttons
 * - export-section.ts: st-export-btn, st-export-btn-primary, st-export-card-toggle
 */

export interface ButtonProps {
  class?: string
  children: string
  onClick: () => void
  disabled?: boolean
  title?: string
  ariaLabel?: string
  type?: 'button' | 'submit' | 'reset'
}

export function Button(props: ButtonProps) {
  return (
    <button
      class={props.class ?? ''}
      type={props.type ?? 'button'}
      disabled={props.disabled === true}
      title={props.title ?? ''}
      aria-label={props.ariaLabel ?? undefined}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  )
}
