// @vitest-environment jsdom
/**
 * The overview, from the keyboard a person actually has.
 *
 * These tests reach the surface the way the application does — a keydown on
 * `document`, from a focused element that is not the overview — because that
 * is the seam a user reaches. A test that called `open()` directly could not
 * report the one defect that matters most here: a chord nothing is listening
 * for.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createOverviewController } from './overview-controller'
import { fakePane, fakeWorkspace, FakeOverviewPort } from './fake-port'
import { clearStack, hasOpenOverlays } from '../ui/overlay/stack'
import { removePortalRoot } from '../ui/overlay/portal'

let dispose: (() => void) | null = null

afterEach(() => {
  dispose?.()
  dispose = null
  clearStack()
  removePortalRoot()
  document.body.innerHTML = ''
})

function chord(): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    code: 'KeyO',
    altKey: true,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })
}

function port(): FakeOverviewPort {
  return new FakeOverviewPort({
    activePaneId: 'a',
    workspaces: [
      fakeWorkspace('w1', 'refactor-auth', [fakePane({ paneId: 'a', title: 'claude' })]),
      fakeWorkspace('w2', 'ansible', [fakePane({ paneId: 'b', title: 'deploy' })]),
    ],
  })
}

function cards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.overview__card'))
}

describe('opening and closing the overview', () => {
  it('opens on ⌥⌘O from wherever the person was typing', () => {
    const p = port()
    const c = createOverviewController(p)
    dispose = () => c.dispose()

    expect(cards().length).toBe(0)
    document.dispatchEvent(chord())
    expect(cards().length).toBe(2)
    expect(c.isOpen()).toBe(true)
  })

  it('closes on Escape', () => {
    const p = port()
    const c = createOverviewController(p)
    dispose = () => c.dispose()

    document.dispatchEvent(chord())
    expect(hasOpenOverlays()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(c.isOpen()).toBe(false)
    expect(cards().length).toBe(0)
    expect(hasOpenOverlays()).toBe(false)
  })

  it('opens once however many times the chord is pressed', () => {
    // Two overlay entries would need two Escapes to get back to the terminal,
    // and the second panel would be drawn over a stale first one.
    const p = port()
    const c = createOverviewController(p)
    dispose = () => c.dispose()

    document.dispatchEvent(chord())
    document.dispatchEvent(chord())
    document.dispatchEvent(chord())

    expect(document.querySelectorAll('.overview').length).toBe(1)
    expect(cards().length).toBe(2)
  })

  it('gives focus back to where it came from', () => {
    const anchor = document.createElement('input')
    document.body.appendChild(anchor)
    anchor.focus()
    expect(document.activeElement).toBe(anchor)

    const p = port()
    const c = createOverviewController(p)
    dispose = () => c.dispose()

    document.dispatchEvent(chord())
    expect(document.activeElement).not.toBe(anchor)
    expect(document.querySelector('.overview')?.contains(document.activeElement)).toBe(true)

    c.close()
    // restoreFocus goes through requestAnimationFrame, as the overlay stack
    // does for every overlay; the assertion waits on the frame, not a clock.
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          expect(document.activeElement).toBe(anchor)
          resolve()
        })
      })
    })
  })

  it('lands the person in the pane they picked, and gets out of the way', () => {
    const p = port()
    const c = createOverviewController(p)
    dispose = () => c.dispose()

    document.dispatchEvent(chord())
    const elsewhere = cards().find((el) => (el.textContent ?? '').includes('deploy'))
    elsewhere!.querySelector<HTMLElement>('.ui-collection-row')!.click()

    expect(p.activated).toEqual(['b'])
    expect(c.isOpen()).toBe(false)
    expect(cards().length).toBe(0)
  })

  it('stops answering the chord once disposed', () => {
    const p = port()
    const c = createOverviewController(p)
    c.dispose()
    dispose = null

    document.dispatchEvent(chord())
    expect(cards().length).toBe(0)
  })
})
