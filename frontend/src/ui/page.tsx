/**
 * Page — the base layout that every application surface is built on.
 *
 * Fills its `.surface-host`, establishes the flex/min-height chain from
 * §6.1 of the shell-kit design spec, and composes the header, optional
 * leading rail, and the content scroller.
 *
 * API: `leading` prop for the rail rather than child composition, because
 * the rail is structurally a sibling of the body (not content inside it)
 * and the narrow-breakpoint layout needs to control the rail's position
 * explicitly. A child-detection approach would require filtering and would
 * break if children were wrapped in a fragment.
 */

import { Show, createEffect, on } from 'solid-js'
import type { JSX } from 'solid-js'
import { PageHeader } from './page-header'
import { PageBody } from './page-body'
import { PageRail } from './page-rail'
import { PageScroller, type PageScrollerHandle } from './page-scroller'

export type { PageScrollerHandle }

export interface PageProps {
  title: string
  description?: string
  actions?: JSX.Element
  /** Keep the title for assistive technology but out of the layout — see
   *  PageHeader. Use it when the surface is opened as a tab that already
   *  carries the same name. */
  titleHidden?: boolean
  /** Optional rail content — placed in `.ui-page__rail`. Pass this as
   *  plain JSX; Page wraps it in the rail container internally. */
  leading?: JSX.Element
  /** Exposes the PageScroller handle for `scrollToElement()` calls. */
  scrollerRef?: PageScrollerHandle | ((h: PageScrollerHandle) => void)
  /** Scroll ownership mode (design spec §3.8).
   *  'page' (default) — PageScroller owns vertical scroll.
   *  'contained' — Page provides a bounded content area; the surface
   *  assigns its own scroll owners (e.g. Connections' two-column panels). */
  scrollMode?: 'page' | 'contained'
  children: JSX.Element
}

export function Page(props: PageProps) {
  let bodyRef: HTMLDivElement | undefined

  /**
   * Focus placement after a page change (§3.8).
   *
   * Switching pages replaces the whole body, and whatever the user had focused goes
   * with it — leaving focus on `document.body`, so the next Tab starts from the top of
   * the window rather than from the page they just opened. Keyboard users lose their
   * place silently; nothing about it is visible.
   *
   * Page owns this because every page needs it and none of them should have to
   * remember: it is the same reason the focus ring lives in base.css rather than in
   * each component. Keyed on `title`, which is the page's identity in the registry.
   *
   * `preventScroll` matters — focusing an element scrolls it into view by default,
   * which would fight the scroll position a page has just been given.
   */
  createEffect(
    on(
      () => props.title,
      (_title, prev) => {
        if (prev === undefined) return // first render is not a page CHANGE
        const active = document.activeElement
        if (active && active !== document.body && bodyRef?.contains(active)) return
        const target = bodyRef?.querySelector<HTMLElement>(
          'input, select, button, [tabindex]:not([tabindex="-1"])',
        )
        target?.focus({ preventScroll: true })
      },
    ),
  )

  return (
    <div class="ui-page" data-scroll={props.scrollMode ?? 'page'}>
      <PageHeader
        title={props.title}
        description={props.description}
        actions={props.actions}
        titleHidden={props.titleHidden}
      />
      <PageBody ref={(el: HTMLDivElement) => (bodyRef = el)}>
        <Show when={props.leading}>
          <PageRail>{props.leading}</PageRail>
        </Show>
        {/* `contained` hands the surface a bounded box and lets it own its scrollers;
            `page` keeps the single PageScroller. A closed mode, not a `:has()` guess
            about what happens to be inside (§3.8). */}
        <Show
          when={(props.scrollMode ?? 'page') === 'contained'}
          fallback={<PageScroller handle={props.scrollerRef}>{props.children}</PageScroller>}
        >
          <div class="ui-page__contained">{props.children}</div>
        </Show>
      </PageBody>
    </div>
  )
}
