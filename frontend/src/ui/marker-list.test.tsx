// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'
import { MarkerList, type MarkerListItem } from './marker-list'

afterEach(() => cleanup())

const ITEMS: MarkerListItem[] = [
  { text: 'SSH connection profiles', tone: 'included' },
  { text: 'Stored passwords', tone: 'excluded' },
  { text: 'SecretID values are opaque references', tone: 'note' },
]

describe('MarkerList', () => {
  it('renders one item per entry, in order', () => {
    const { container } = render(() => <MarkerList items={ITEMS} />)
    const items = container.querySelectorAll('.ui-marker-list__item')
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toContain('SSH connection profiles')
  })

  it('carries the stance as data-tone', () => {
    const { container } = render(() => <MarkerList items={ITEMS} />)
    const tones = [...container.querySelectorAll('.ui-marker-list__item')].map((el) =>
      el.getAttribute('data-tone'),
    )
    expect(tones).toEqual(['included', 'excluded', 'note'])
  })

  // The glyph belongs to the tone, so a caller cannot get it wrong or invent one.
  it('draws + for included and a minus sign for excluded, and none for a note', () => {
    const { container } = render(() => <MarkerList items={ITEMS} />)
    const markers = [...container.querySelectorAll('.ui-marker-list__marker')].map(
      (el) => el.textContent,
    )
    expect(markers).toEqual(['+', '−', ''])
  })

  it('hides the markers from assistive technology', () => {
    const { container } = render(() => <MarkerList items={ITEMS} />)
    for (const marker of container.querySelectorAll('.ui-marker-list__marker')) {
      expect(marker.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('renders nothing but the list when empty', () => {
    const { container } = render(() => <MarkerList items={[]} />)
    expect(container.querySelector('.ui-marker-list')).toBeTruthy()
    expect(container.querySelectorAll('.ui-marker-list__item')).toHaveLength(0)
  })
})
