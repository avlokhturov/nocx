import { splitProps, type JSX } from 'solid-js'

export type IconButtonSize = 'sm' | 'md'

export interface IconButtonProps {
  /**
   * Square corners, for a button that sits flush in a strip rather than floating in
   * a toolbar. The vertical tab strip wants them; it was setting `border-radius: 0`
   * on `.ui-icon-button` from style.css, which is a surface changing a component's
   * shape (nocx-etu2).
   */
  square?: boolean
  /** See button.tsx: `never` refuses it at compile time and keeps it splittable at
   *  runtime, which is the half that matters. */
  class?: never
  className?: never
  selected?: boolean
  size?: IconButtonSize
  tabIndex?: number
  onClick?: (e: MouseEvent) => void
  disabled?: boolean
  title?: string
  /** Required — an icon-only control with no accessible name is a defect. */
  ariaLabel: string
  /** Show a vertical selection indicator bar (used in activity bar rail context). */
  railIndicator?: boolean
  children: JSX.Element
}

type IconButtonAttrs = IconButtonProps & JSX.IntrinsicElements['button']

/**
 * IconButton — an icon-only action affordance.
 *
 * Renders `class="ui-icon-button"` with `data-size` for variance. Does not
 * accept a `class` prop — appearance is locked to the kit.
 *
 * Roving tabindex stays with the group; this component only accepts `tabIndex`
 * and `selected` and manages nothing.
 */
export function IconButton(props: IconButtonAttrs) {
  // `class`/`className` are split off and DISCARDED — see the props declaration.
  const knownKeys = [
    'class',
    'className',
    'selected',
    'square',
    'size',
    'tabIndex',
    'onClick',
    'disabled',
    'title',
    'ariaLabel',
    'type',
    'railIndicator',
    'children',
  ] as const
  const [local, rest] = splitProps(props, knownKeys)
  return (
    <button
      class="ui-icon-button"
      data-size={local.size ?? 'md'}
      aria-selected={local.selected === true ? 'true' : undefined}
      data-square={local.square === true ? 'true' : undefined}
      data-rail-indicator={local.railIndicator === true ? 'true' : undefined}
      aria-label={local.ariaLabel}
      disabled={local.disabled === true}
      title={local.title ?? ''}
      tabIndex={local.tabIndex}
      type={local.type ?? 'button'}
      onClick={(e: MouseEvent) => local.onClick?.(e)}
      {...rest}
    >
      {local.children}
    </button>
  )
}
