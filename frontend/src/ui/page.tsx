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

import { Show } from 'solid-js'
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
  return (
    <div class="ui-page" data-scroll={props.scrollMode ?? 'page'}>
      <PageHeader
        title={props.title}
        description={props.description}
        actions={props.actions}
        titleHidden={props.titleHidden}
      />
      <PageBody>
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
