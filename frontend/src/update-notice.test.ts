// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { UpdateNotice } from './main'

describe('UpdateNotice', () => {
  // ── Pinned defect: showAvailable does not reset className ──────────────
  // All three transitions fail because showAvailable() (main.tsx:43-61)
  // sets display and innerHTML but never restores className to 'update-notice'.
  // After any error/downloading/pending state, the previous class persists.
  // Fix: add `this.el.className = 'update-notice'` inside showAvailable.

  it.fails('error→available resets className (nocx-82l9.1)', () => {
    const bar = document.createElement('div')
    const notice = new UpdateNotice(bar)

    notice.showError('connection lost')
    notice.showAvailable('1.0.0', 'https://example.com/release')

    const el = bar.querySelector('.update-notice')
    expect(el).not.toBeNull()
    expect(el!.className).toBe('update-notice')
  })

  it.fails('downloading→available resets className (nocx-82l9.1)', () => {
    const bar = document.createElement('div')
    const notice = new UpdateNotice(bar)

    notice.showDownloading()
    notice.showAvailable('1.0.0', 'https://example.com/release')

    const el = bar.querySelector('.update-notice')
    expect(el).not.toBeNull()
    expect(el!.className).toBe('update-notice')
  })

  it.fails('pending→available resets className (nocx-82l9.1)', () => {
    const bar = document.createElement('div')
    const notice = new UpdateNotice(bar)

    notice.showPendingRestart('1.0.0')
    notice.showAvailable('1.0.0', 'https://example.com/release')

    const el = bar.querySelector('.update-notice')
    expect(el).not.toBeNull()
    expect(el!.className).toBe('update-notice')
  })

  // ── Individual state setters are correct ──────────────────────────────

  it('showDownloading sets downloading class (passing)', () => {
    const bar = document.createElement('div')
    const notice = new UpdateNotice(bar)

    notice.showDownloading()

    const el = bar.querySelector('.update-notice')
    expect(el).not.toBeNull()
    expect(el!.className).toBe('update-notice downloading')
  })

  it('showPendingRestart sets pending class (passing)', () => {
    const bar = document.createElement('div')
    const notice = new UpdateNotice(bar)

    notice.showPendingRestart('1.0.0')

    const el = bar.querySelector('.update-notice')
    expect(el).not.toBeNull()
    expect(el!.className).toBe('update-notice pending')
  })

  it('showError sets error class (passing)', () => {
    const bar = document.createElement('div')
    const notice = new UpdateNotice(bar)

    notice.showError('connection lost')

    const el = bar.querySelector('.update-notice')
    expect(el).not.toBeNull()
    expect(el!.className).toBe('update-notice error')
  })

  it('showAvailable sets correct content (passing)', () => {
    const bar = document.createElement('div')
    const notice = new UpdateNotice(bar)

    notice.showAvailable('1.0.0', 'https://example.com/release')

    const el = bar.querySelector('.update-notice')
    expect(el).not.toBeNull()
    expect(el!.textContent).toContain('1.0.0 available')
    expect(el!.querySelector('a')).not.toBeNull()
    expect(el!.querySelector('button')).not.toBeNull()
  })
})
