import { splitProps, type JSX } from 'solid-js'

export type IconButtonSize = 'sm' | 'md'

export interface IconButtonProps {
  selected?: boolean
  size?: IconButtonSize
  tabIndex?: number
  onClick?: (e: MouseEvent) => void
  disabled?: boolean
  title?: string
  /** Required — an icon-only control with no accessible name is a defect. */
  ariaLabel: string
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
  const knownKeys = [
    'selected',
    'size',
    'tabIndex',
    'onClick',
    'disabled',
    'title',
    'ariaLabel',
    'type',
    'children',
  ] as const
  const [local, rest] = splitProps(props, knownKeys)
  return (
    <button
      class="ui-icon-button"
      data-size={local.size ?? 'md'}
      aria-selected={local.selected === true ? 'true' : undefined}
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
