// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { cleanup } from '@solidjs/testing-library'
import { HorizontalTabStrip, VerticalTabStrip } from './tab-strip'
import type { TabView } from './tab-strip'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function makeTab(id: number, title: string, tooltip: string): TabView {
  return {
    id,
    title,
    tooltip,
    // The strip's filter reads the tooltip whether or not a second line is shown,
    // so these fixtures keep it searchable and leave the line itself empty.
    subtitle: '',
    hasActivity: false,
    agentStatus: null,
    paneId: `pane-${id}`,
    onDisplayChange: null,
  }
}

function setupVerticalStrip(): {
  strip: VerticalTabStrip
  container: HTMLElement
} {
  const strip = new VerticalTabStrip()
  const container = document.createElement('div')
  container.id = 'vertical-tabstrip'
  document.body.appendChild(container)
  strip.mount(container)
  return { strip, container }
}

function getSearchInput(): HTMLInputElement | null {
  return document.querySelector('input[type="search"]')
}

function getTabEl(idx: number): HTMLElement | null {
  const tabs = document.querySelectorAll('.nocx-tab')
  return (tabs[idx] as HTMLElement) ?? null
}

function isHidden(el: HTMLElement): boolean {
  return el.getAttribute('data-hidden') === 'true'
}

describe('VerticalTabStrip filtering', () => {
  it('renders search field in vertical mode', () => {
    setupVerticalStrip()
    const input = getSearchInput()
    expect(input).toBeTruthy()
  })

  it('filtering by title substring keeps matching rows and hides the rest', () => {
    const { strip } = setupVerticalStrip()
    strip.addTab(makeTab(1, 'local terminal', '~/repos/nocx'))
    strip.addTab(makeTab(2, 'SSH: server-01', 'ssh user@server-01'))
    strip.addTab(makeTab(3, 'SSH: database', 'ssh dba@db-host'))

    const input = getSearchInput()!
    expect(input).toBeTruthy()

    // Simulate typing 'server' in the search field
    input.value = 'server'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Tab 1 doesn't contain 'server' → hidden
    expect(isHidden(getTabEl(0)!)).toBe(true)
    // Tab 2 title contains 'server' → visible
    expect(isHidden(getTabEl(1)!)).toBe(false)
    // Tab 3 doesn't contain 'server' → hidden
    expect(isHidden(getTabEl(2)!)).toBe(true)
  })

  it('filtering by tooltip (cwd/host) substring matches too', () => {
    const { strip } = setupVerticalStrip()
    strip.addTab(makeTab(1, 'local terminal', '~/repos/nocx'))
    strip.addTab(makeTab(2, 'SSH: web', 'ssh deploy@web-01.prod'))

    const input = getSearchInput()!
    input.value = 'deploy'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Tab 1 tooltip doesn't contain 'deploy' → hidden
    expect(isHidden(getTabEl(0)!)).toBe(true)
    // Tab 2 tooltip contains 'deploy' → visible
    expect(isHidden(getTabEl(1)!)).toBe(false)
  })

  it('clearing the query restores every row', () => {
    const { strip } = setupVerticalStrip()
    strip.addTab(makeTab(1, 'local terminal', '~/repos/nocx'))
    strip.addTab(makeTab(2, 'SSH: server', 'ssh user@server'))

    const input = getSearchInput()!

    // Filter to show only 'server'
    input.value = 'server'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(isHidden(getTabEl(0)!)).toBe(true)
    expect(isHidden(getTabEl(1)!)).toBe(false)

    // Clear the field
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Both should be visible again
    expect(isHidden(getTabEl(0)!)).toBe(false)
    expect(isHidden(getTabEl(1)!)).toBe(false)
  })

  it('filtering does not change which tab is active', () => {
    const { strip } = setupVerticalStrip()
    strip.addTab(makeTab(1, 'local terminal', '~/repos/nocx'))
    strip.addTab(makeTab(2, 'SSH: server', 'ssh user@server'))
    strip.setActive(1)

    // Verify tab 1 is active
    const tab1 = getTabEl(0)!
    expect(tab1.getAttribute('aria-selected')).toBe('true')

    const input = getSearchInput()!
    input.value = 'server'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Tab 1 is hidden by the filter but still active
    expect(isHidden(tab1)).toBe(true)
    expect(tab1.getAttribute('aria-selected')).toBe('true')
  })
})

describe('the snippets action (nocx-d346)', () => {
  // The strip is a presentation port: it reports that the button was
  // pressed and where it is, and knows nothing about a library. The anchor
  // travels with the intent because the menu is a popover, and a caller
  // that had to find the button again would be reading the strip's DOM.
  const anchorOf = (strip: { onSnippets: ((a: { x: number; y: number }) => void) | null }) => {
    const seen: { x: number; y: number }[] = []
    strip.onSnippets = (a) => seen.push(a)
    return seen
  }

  it('the vertical strip offers it and reports the button as the anchor', () => {
    const { strip } = setupVerticalStrip()
    const seen = anchorOf(strip)

    const button = document.querySelector<HTMLButtonElement>('[aria-label="Snippets"]')
    expect(button, 'the vertical strip has no snippets action').not.toBeNull()
    button!.click()

    expect(seen).toHaveLength(1)
    // jsdom lays nothing out, so the numbers are zeroes — what this asserts
    // is that the strip measured the BUTTON rather than inventing a point.
    expect(seen[0]).toEqual({ x: 0, y: 0 })
  })

  it('the horizontal strip offers it too — a strip replacement must not lose it', () => {
    const strip = new HorizontalTabStrip()
    const container = document.createElement('div')
    document.body.appendChild(container)
    strip.mount(container)
    const seen = anchorOf(strip)

    const button = document.querySelector<HTMLButtonElement>('[aria-label="Snippets"]')
    expect(button, 'the horizontal strip has no snippets action').not.toBeNull()
    button!.click()

    expect(seen).toHaveLength(1)
  })

  it('with no callback wired the button is inert rather than broken', () => {
    setupVerticalStrip()
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Snippets"]')!
    expect(() => button.click()).not.toThrow()
  })
})
