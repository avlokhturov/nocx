import type { JSX } from 'solid-js'
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
  children: JSX.Element
  onClick: () => void
  disabled?: boolean
  title?: string
  ariaLabel?: string
  type?: 'button' | 'submit' | 'reset'
  variant?: ButtonVariant
  /**
   * Roving-tabindex participation. Chrome controls that sit inside a toolbar
   * managing its own focus order need -1 so they are not a second tab stop.
   * Added for the tab strip's quick-connect caret (nocx-imkb.7) — the first
   * time a chrome-sized control tried to use the kit and found it did not fit,
   * which is what nocx-vxqj.8 is about.
   */
  tabIndex?: number
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
      tabIndex={props.tabIndex}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  )
}
