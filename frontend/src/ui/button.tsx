import { splitProps } from 'solid-js'
import type { JSX } from 'solid-js'

/**
 * Button — the terminal's action affordance.
 *
 * Justified by callers:
 * - settings.ts: st-retry-btn, st-secret-replace/clear, st-reset-btn
 * - connections.ts: cm-primary/new, cm-save, cm-connect, cm-danger, cm-quick-connect, plain toolbar buttons
 * - export-section.ts: st-export-btn, st-export-btn-primary, st-export-card-toggle
 * - banner.ts: clipboard-banner-allow, clipboard-banner-suppress, clipboard-banner-dismiss
 * - sidebar.ts: activity-bar view/action buttons
 * - tab-strip.ts: tab-close, tab-add
 * - update-notice.ts: update-apply-btn
 */

export type ButtonVariant = 'default' | 'secondary' | 'primary' | 'danger' | 'close'

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  // `default` maps to no class on purpose: 27 call sites pass their own fully
  // formed class (.tab-add, .cm-save, activity-bar buttons) and adding a base
  // class underneath them would fight rules that assume a bare button. The
  // consequence is that a Button with neither a variant nor a class renders as
  // native platform chrome — tracked separately, it needs a per-caller pass.
  default: '',
  secondary: 'ui-btn-secondary',
  primary: 'ui-btn-primary',
  danger: 'ui-btn-danger',
  close: 'ui-btn-close',
}

export interface ButtonProps {
  class?: string
  children: JSX.Element
  onClick: (e: MouseEvent) => void
  disabled?: boolean
  title?: string
  ariaLabel?: string
  type?: 'button' | 'submit' | 'reset'
  variant?: ButtonVariant
  /**
   * Roving-tabindex participation. Chrome controls that sit inside a toolbar
   * managing their own focus order need -1 so they are not a second tab stop.
   */
  tabIndex?: number
}

type ButtonAttrs = ButtonProps & JSX.IntrinsicElements['button']

export function Button(props: ButtonAttrs) {
  const knownKeys = [
    'class',
    'children',
    'onClick',
    'disabled',
    'title',
    'ariaLabel',
    'type',
    'variant',
    'tabIndex',
  ] as const
  const [local, rest] = splitProps(props, knownKeys)
  const variantClass = () => VARIANT_CLASS[local.variant ?? 'default']
  return (
    <button
      class={`${variantClass()} ${local.class ?? ''}`.trim()}
      type={local.type ?? 'button'}
      disabled={local.disabled === true}
      title={local.title ?? ''}
      aria-label={local.ariaLabel ?? undefined}
      tabIndex={local.tabIndex}
      onClick={(e: MouseEvent) => local.onClick(e)}
      {...rest}
    >
      {local.children}
    </button>
  )
}
