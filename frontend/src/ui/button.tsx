/**
 * Button — the terminal's action affordance.
 *
 * Justified by callers:
 * - settings.ts: st-retry-btn, st-secret-replace/clear, st-reset-btn
 * - connections.ts: cm-primary/new, cm-save, cm-connect, cm-danger, cm-quick-connect, plain toolbar buttons
 * - export-section.ts: st-export-btn, st-export-btn-primary, st-export-card-toggle
 */

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'close'

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: '',
  primary: 'ui-btn-primary',
  danger: 'ui-btn-danger',
  close: 'ui-btn-close',
}

export interface ButtonProps {
  class?: string
  children: string
  onClick: () => void
  disabled?: boolean
  title?: string
  ariaLabel?: string
  type?: 'button' | 'submit' | 'reset'
  variant?: ButtonVariant
}

export function Button(props: ButtonProps) {
  const variantClass = () => VARIANT_CLASS[props.variant ?? 'default']
  return (
    <button
      class={`${variantClass()} ${props.class ?? ''}`.trim()}
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
