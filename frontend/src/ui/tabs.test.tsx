// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@solidjs/testing-library'
import { Tabs, type TabsProps, type TabItemStatus } from './tabs'

afterEach(() => cleanup())

function subject(overrides?: Partial<TabsProps>) {
  const props: TabsProps = {
    items: [
      { id: 'a', label: 'A', content: () => 'Content A' },
      { id: 'b', label: 'B', content: () => 'Content B' },
    ],
    active: 'a',
    onChange: () => {},
    ...overrides,
  }
  return render(() => <Tabs {...props} />)
}

describe('Tabs', () => {
  it('renders all tab labels', () => {
    subject()
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('B')).toBeTruthy()
  })

  it('has ui-tabs class identity', () => {
    subject()
    const el = document.querySelector('.ui-tabs')
    expect(el).toBeTruthy()
  })

  it('has ui-tabs__list class identity', () => {
    subject()
    const el = document.querySelector('.ui-tabs__list')
    expect(el).toBeTruthy()
  })

  describe('status indicator', () => {
    it('does not render .ui-status-dot when no status is set', () => {
      subject()
      expect(document.querySelector('.ui-status-dot')).toBeNull()
    })

    it('renders .ui-status-dot when status is set', () => {
      const status: TabItemStatus = { tone: 'ok', accessibleName: 'Available' }
      subject({
        items: [
          { id: 'a', label: 'Store A', content: () => 'A', status },
          { id: 'b', label: 'Store B', content: () => 'B' },
        ],
      })
      expect(document.querySelector('.ui-status-dot')).toBeTruthy()
    })

    it('sets data-tone attribute matching the tone', () => {
      const status: TabItemStatus = { tone: 'ok', accessibleName: 'Available' }
      subject({
        items: [{ id: 'a', label: 'A', content: () => 'A', status }],
      })
      const marker = document.querySelector('.ui-status-dot')
      expect(marker!.getAttribute('data-tone')).toBe('ok')
    })

    it('renders all three tones ok/warning/error', () => {
      subject({
        items: [
          { id: 'a', label: 'A', content: () => 'A', status: { tone: 'ok', accessibleName: 'Ok' } },
          {
            id: 'b',
            label: 'B',
            content: () => 'B',
            status: { tone: 'warning', accessibleName: 'Warn' },
          },
          {
            id: 'c',
            label: 'C',
            content: () => 'C',
            status: { tone: 'error', accessibleName: 'Err' },
          },
        ],
      })
      const markers = document.querySelectorAll('.ui-status-dot')
      expect(markers[0].getAttribute('data-tone')).toBe('ok')
      expect(markers[1].getAttribute('data-tone')).toBe('warning')
      expect(markers[2].getAttribute('data-tone')).toBe('error')
    })

    it('accessible name is reachable via accessible query on the tab', () => {
      subject({
        items: [
          {
            id: 's',
            label: 'Test Store',
            content: () => 'Content',
            status: { tone: 'error', accessibleName: 'Not responding' },
          },
        ],
      })
      // The button's computed accessible name includes both the visible label
      // and the visually-hidden status text. Regex to confirm both are present.
      const tab = screen.getByRole('tab', { name: /Test Store.*Not responding/ })
      expect(tab).toBeTruthy()
    })

    it('marker is aria-hidden', () => {
      subject({
        items: [
          {
            id: 'a',
            label: 'A',
            content: () => 'A',
            status: { tone: 'ok', accessibleName: 'Available' },
          },
        ],
      })
      const marker = document.querySelector('.ui-status-dot')
      expect(marker!.getAttribute('aria-hidden')).toBe('true')
    })

    it('marker is visible on the unselected row', () => {
      subject({
        active: 'b',
        items: [
          {
            id: 'a',
            label: 'Store A',
            content: () => 'A',
            status: { tone: 'warning', accessibleName: 'Unstable' },
          },
          { id: 'b', label: 'Store B', content: () => 'B' },
        ],
      })
      const marker = document.querySelector('.ui-status-dot')
      expect(marker).toBeTruthy()
      // The marker must be visible even when its row is not selected —
      // that is the entire point of the feature.
      const style = window.getComputedStyle(marker!)
      expect(style.display).not.toBe('none')
      expect(style.visibility).not.toBe('hidden')
    })
  })
})
