// banner-model — pure functions only, no jsdom, no Solid.
import { describe, it, expect } from 'vitest'
import { createBannerState, showBanner, dismissBanner } from './banner-model'

// ── createBannerState ──────────────────────────────────────────────────────

describe('createBannerState', () => {
  it('creates state with banner not yet shown', () => {
    const s = createBannerState()
    expect(s.shown).toBe(false)
  })
})

// ── showBanner ─────────────────────────────────────────────────────────────

describe('showBanner', () => {
  it('marks the banner as shown', () => {
    const s = createBannerState()
    const next = showBanner(s)
    expect(next.shown).toBe(true)
  })

  it('stays shown after repeated calls', () => {
    const s = showBanner(createBannerState())
    const s2 = showBanner(s)
    expect(s2.shown).toBe(true)
  })

  it('does not mutate the input', () => {
    const s = createBannerState()
    showBanner(s)
    expect(s.shown).toBe(false)
  })
})

// ── dismissBanner ──────────────────────────────────────────────────────────

describe('dismissBanner', () => {
  it('clears the shown flag', () => {
    const s = showBanner(createBannerState())
    const next = dismissBanner(s)
    expect(next.shown).toBe(false)
  })

  it('dismissing a not-shown banner is a no-op data-wise', () => {
    const s = createBannerState()
    const next = dismissBanner(s)
    expect(next.shown).toBe(false)
  })
})
