/**
 * The grid is never wider than the box it is drawn in (nocx-vydj).
 *
 * The height half of this invariant was learned the hard way in nocx-6w4z: the
 * grid was fitted to the pane while it was shown in a scroller shorter than the
 * pane, and the bottom rows had nowhere to be drawn. The width half was left
 * unfixed and fails the same way, one axis over — the viewport delivered to
 * content is `pane.getBoundingClientRect()`, a BORDER box that includes
 * `.pane`'s `padding: 0 10px`, so `cols` was computed from 20px the grid does
 * not have and the last columns landed past the right edge of `.xterm-inner`,
 * where its `overflow: hidden` cut them mid-glyph.
 *
 * Why this must run in a browser and in BOTH engines: the amount clipped
 * differs by engine, because `scrollbar-gutter: stable` on `.scrollback-area`
 * reserves 10px in Chromium and is ignored by WebKit. Measured at a 1232px
 * pane, the same build overhung by 20px in Chromium and 10px in WKWebView —
 * which is why the defect was reported as "the packaged app clips and the
 * browser does not". A jsdom test cannot see any of it: there is no layout, so
 * `clientWidth` is 0 and `usableViewport` returns the delivered box unchanged.
 */

import { test, expect } from './harness'

test('the grid is not wider than the scroller it is drawn in', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.pane.active .xterm-screen')

  // Give the fit path its resize + rAF; the first fit runs during mount and the
  // authoritative one arrives with the next viewport delivery.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const pane = document.querySelector('.pane.active')
          const area = pane?.querySelector('.scrollback-area') as HTMLElement | null
          const screen = pane?.querySelector('.xterm-screen') as HTMLElement | null
          if (!area || !screen) return null
          return Math.round(screen.getBoundingClientRect().width - area.clientWidth)
        }),
      { timeout: 10_000 },
    )
    // At most zero: whole cells rarely tile the box exactly, so the grid is
    // normally a few pixels NARROWER. Any positive number is a column the user
    // cannot see.
    .toBeLessThanOrEqual(0)

  // …and it still fills the scroller. "Not too wide" is satisfied just as well
  // by a grid of two columns, so the second half of the invariant has to be
  // stated too: whole cells rarely tile the box exactly, but the leftover is a
  // fraction of one column and never a visible margin.
  const fill = await page.evaluate(() => {
    const pane = document.querySelector('.pane.active')
    const area = pane?.querySelector('.scrollback-area') as HTMLElement | null
    const screen = pane?.querySelector('.xterm-screen') as HTMLElement | null
    if (!area || !screen) return 0
    return screen.getBoundingClientRect().width / area.clientWidth
  })
  expect(fill).toBeGreaterThan(0.98)
})
