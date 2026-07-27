import { splitProps } from 'solid-js'
import type { JSX } from 'solid-js'

/**
 * Button — the terminal's action affordance.
 *
 * The button carries `class="ui-button"` on the `<button>` element and
 * `data-variant` / `data-size` for variance (§3.1 of the design spec).
 *
 * Variant vocabulary: `default` (neutral, today's secondary appearance),
 * `primary` (accent-filled), `danger` (danger outline).
 *
 * `class` is intentionally absent as a prop — appearance is locked to
 * the kit (§3.6). Layout and placement belong to a parent wrapper or
 * a typed prop.
 */

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps {
  children: JSX.Element
  onClick: (e: MouseEvent) => void
  disabled?: boolean
  title?: string
  ariaLabel?: string
  type?: 'button' | 'submit' | 'reset'
  variant?: ButtonVariant
  size?: ButtonSize
  /**
   * Roving-tabindex participation. Chrome controls that sit inside a toolbar
   * managing their own focus order need -1 so they are not a second tab stop.
   */
  tabIndex?: number
}

type ButtonAttrs = ButtonProps & JSX.IntrinsicElements['button']

export function Button(props: ButtonAttrs) {
  const knownKeys = [
    'children',
    'onClick',
    'disabled',
    'title',
    'ariaLabel',
    'type',
    'variant',
    'size',
    'tabIndex',
  ] as const
  const [local, rest] = splitProps(props, knownKeys)
  return (
    <button
      class="ui-button"
      data-variant={local.variant ?? 'default'}
      {...(local.size && local.size !== 'md' ? { 'data-size': local.size } : {})}
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
