// @vitest-environment jsdom
/**
 * Characterization test for ClipboardBanner — tests only the interface
 * contract (ClipboardBanner.shown, ClipboardBanner.show()) so it validates
 * both the imperative and Solid implementations identically.
 *
 * Must be kept as a .test.ts file (not .tsx) because the Solid rewrite
 * will be tested through it — the test has no JSX of its own, so it
 * must not trigger Solid JSX transforms before the implementation does.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { ClipboardBannerImpl, type ClipboardBanner } from './banner'

function mountPanes(): HTMLElement {
  const panes = document.createElement('div')
  panes.id = 'panes'
  document.body.append(panes)
  return panes
}

function click(sel: string): void {
  const el = document.querySelector<HTMLElement>(sel)
  if (!el) throw new Error(`no element for ${sel}`)
  el.click()
}

function makeBanner(): ClipboardBanner {
  return new ClipboardBannerImpl()
}

describe('ClipboardBanner', () => {
  let panes: HTMLElement

  beforeEach(() => {
    panes = mountPanes()
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  // ── shown transitions ─────────────────────────────────────────

  it('shown is false when no banner is displayed', () => {
    const banner = makeBanner()
    expect(banner.shown).toBe(false)
  })

  it('shown is true while a banner is on screen', async () => {
    const banner = makeBanner()
    const promise = banner.show()
    expect(banner.shown).toBe(true)
    click('[aria-label="Dismiss"]')
    await promise
  })

  it('shown is false after the user makes a choice', async () => {
    const banner = makeBanner()
    const choice = banner.show()
    click('[aria-label="Dismiss"]')
    await choice
    expect(banner.shown).toBe(false)
  })

  // ── Three choices produce correct results ─────────────────────

  it('resolves with "allow" when allow is clicked', async () => {
    const banner = makeBanner()
    const choice = banner.show()
    click('.clipboard-banner-allow')
    expect(await choice).toBe('allow')
  })

  it('resolves with "suppress" when suppress is clicked', async () => {
    const banner = makeBanner()
    const choice = banner.show()
    click('.clipboard-banner-suppress')
    expect(await choice).toBe('suppress')
  })

  it('resolves with "dismiss" when dismiss is clicked', async () => {
    const banner = makeBanner()
    const choice = banner.show()
    click('[aria-label="Dismiss"]')
    expect(await choice).toBe('dismiss')
  })

  // ── Dismiss is "not now", not "never" ─────────────────────────

  it('asks again after a dismiss', async () => {
    const banner = makeBanner()

    const first = banner.show()
    click('[aria-label="Dismiss"]')
    expect(await first).toBe('dismiss')

    const second = banner.show()
    expect(banner.shown).toBe(true)
    expect(document.querySelector('.clipboard-banner')).not.toBeNull()

    click('.clipboard-banner-allow')
    expect(await second).toBe('allow')
  })

  // ── No stacking ───────────────────────────────────────────────

  it('does not stack a second banner while one is on screen', async () => {
    const banner = makeBanner()

    const first = banner.show()
    // Calling show() while already shown drops the redundant promise
    expect(await banner.show()).toBe('dismiss')
    expect(document.querySelectorAll('.clipboard-banner')).toHaveLength(1)

    click('.clipboard-banner-suppress')
    expect(await first).toBe('suppress')
  })

  // ── DOM footprint ─────────────────────────────────────────────

  it('renders a banner element inside #panes while showing', async () => {
    const banner = makeBanner()
    const promise = banner.show()
    expect(panes.querySelector('.clipboard-banner')).not.toBeNull()

    click('[aria-label="Dismiss"]')
    await promise
    expect(panes.querySelector('.clipboard-banner')).toBeNull()
  })

  it('removes the banner element after allow', async () => {
    const banner = makeBanner()
    const choice = banner.show()
    click('.clipboard-banner-allow')
    await choice
    expect(panes.querySelector('.clipboard-banner')).toBeNull()
  })

  it('removes the banner element after suppress', async () => {
    const banner = makeBanner()
    const choice = banner.show()
    click('.clipboard-banner-suppress')
    await choice
    expect(panes.querySelector('.clipboard-banner')).toBeNull()
  })
})
