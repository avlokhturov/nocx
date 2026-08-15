/**
 * Caption — the kit's group-caption register (nocx-dgsp).
 *
 * The app's caption vocabulary for a label over a group of rows: uppercase,
 * letter-spaced, semibold, small, muted. It is the register the existing
 * captions already speak (sidebar.css `.sidebar-title`, floating-panel.css
 * `.ui-floating-panel__group`, connections.css `.cm-group-header`) — this is
 * the one owner of it, so a new surface composes the kit rather than writing
 * a fifth copy.
 *
 * Identity: `.ui-caption`. Surfaces place it (margin, width, position) and
 * never repaint it; the padding that positions a caption inside its rail is
 * the caller's wrapper, not this element.
 */

import type { JSX } from 'solid-js'

export interface CaptionProps {
  children: JSX.Element
}

export function Caption(props: CaptionProps) {
  return <span class="ui-caption">{props.children}</span>
}
