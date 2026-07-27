/**
 * PageHeader — title, optional description, and optional actions bar for a
 * page. Renders `.ui-page__header`.
 */

import { Show } from 'solid-js'
import type { JSX } from 'solid-js'

export interface PageHeaderProps {
  title: string
  description?: string
  actions?: JSX.Element
  /**
   * Drop the title out of the visual layout while keeping it for assistive
   * technology. For a surface opened as a tab the tab label already names it,
   * so a repeated heading only costs vertical space — but the page still needs
   * an accessible name, so the h1 stays in the accessibility tree rather than
   * being deleted.
   */
  titleHidden?: boolean
}

export function PageHeader(props: PageHeaderProps) {
  return (
    <div class="ui-page__header" classList={{ 'ui-page__header--bare': props.titleHidden }}>
      <h1 classList={{ 'ui-visually-hidden': props.titleHidden }}>{props.title}</h1>
      <Show when={props.description}>
        <p>{props.description}</p>
      </Show>
      <Show when={props.actions}>
        <div class="ui-page__header-actions">{props.actions}</div>
      </Show>
    </div>
  )
}
