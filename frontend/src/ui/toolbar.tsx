/**
 * Toolbar — horizontal action bar at the top of a view.
 *
 * Justified by callers:
 * - connections.ts: div.cm-header > h1 + action buttons (header toolbar)
 * - settings-content.ts: nav.st-rail (section nav + search + filter toolbar)
 *
 * No `class` passthrough — see page-section.tsx for why the structural containers
 * stopped accepting one.
 */

import type { JSX } from 'solid-js'

export interface ToolbarProps {
  children: JSX.Element
  ariaLabel?: string
}

export function Toolbar(props: ToolbarProps) {
  return (
    <div role="toolbar" class="ui-toolbar" aria-label={props.ariaLabel ?? undefined}>
      {props.children}
    </div>
  )
}
