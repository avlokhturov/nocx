/**
 * Toolbar — horizontal action bar at the top of a view.
 *
 * Justified by callers:
 * - connections.ts: div.cm-header > h1 + action buttons (header toolbar)
 * - settings-content.ts: nav.st-rail (section nav + search + filter toolbar)
 */

import type { JSX } from 'solid-js'

export interface ToolbarProps {
  class?: string
  children: JSX.Element
}

export function Toolbar(props: ToolbarProps) {
  return <div class={props.class ?? ''}>{props.children}</div>
}
