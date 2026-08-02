// @vitest-environment jsdom
// CompletionDropdown — the kit component's contract: it renders candidates,
// reports hover/pick, and never inserts anything itself (displayText is what
// a row shows; insertText belongs to the controller).
import { describe, it, expect, vi } from 'vitest'
import {
  CompletionDropdown,
  MAX_DROPDOWN_WIDTH_PX,
  MIN_DROPDOWN_WIDTH_PX,
} from './completion-dropdown'
import type { Candidate } from '../suggest/candidate'

const cand = (over: Partial<Candidate>): Candidate => ({
  id: 'c1',
  targetId: 'shell',
  providerId: 'command',
  displayText: 'git status',
  insertText: 'git status',
  replacement: { from: 0, to: 7 },
  matchRanges: [{ from: 0, to: 7 }],
  source: 'command',
  eligibleForGhostText: true,
  ...over,
})

const mount = () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const onHover = vi.fn()
  const onPick = vi.fn()
  const dd = new CompletionDropdown({ onHover, onPick })
  dd.mount(container)
  return { dd, container, onHover, onPick }
}

describe('CompletionDropdown', () => {
  it('starts closed and unmounted rows are absent', () => {
    const { dd } = mount()
    expect(dd.isOpen).toBe(false)
    expect(dd.root.dataset.open).toBe('false')
  })

  it('renders one row per candidate with the selected variance', () => {
    const { dd } = mount()
    dd.show([cand({ id: 'a' }), cand({ id: 'b' })], 1)
    expect(dd.isOpen).toBe(true)
    const rows = dd.root.querySelectorAll('.ui-completion-dropdown__row')
    expect(rows).toHaveLength(2)
    expect(rows[1].getAttribute('aria-selected')).toBe('true')
    expect(rows[0].getAttribute('aria-selected')).toBe('false')
  })

  it('highlights the match ranges inside the display text', () => {
    const { dd } = mount()
    dd.show([cand({ displayText: 'git status', matchRanges: [{ from: 0, to: 7 }] })], 0)
    const marks = dd.root.querySelectorAll('.ui-completion-dropdown__match')
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent).toBe('git sta')
  })

  it('shows the source badge — displayed, never inserted', () => {
    const { dd } = mount()
    dd.show([cand({ source: 'path' })], 0)
    const badge = dd.root.querySelector('.ui-completion-dropdown__source')
    expect(badge?.textContent).toBe('path')
  })

  it('renders the kind word for path rows — displayed, never inserted', () => {
    const { dd } = mount()
    dd.show(
      [
        cand({ id: 'd', source: 'path', kind: 'directory', displayText: 'src/' }),
        cand({ id: 'f', source: 'path', kind: 'file', displayText: 'notes.txt' }),
      ],
      0,
    )
    const kinds = dd.root.querySelectorAll('.ui-completion-dropdown__kind')
    expect(kinds).toHaveLength(2)
    expect(kinds[0].textContent).toBe('Directory')
    expect(kinds[1].textContent).toBe('File')
    // A row without a kind renders no kind badge.
    dd.show([cand({ id: 'c' })], 0)
    expect(dd.root.querySelectorAll('.ui-completion-dropdown__kind')).toHaveLength(0)
  })

  it('reports hover and pick with the row index', () => {
    const { dd, onHover, onPick } = mount()
    dd.show([cand({ id: 'a' }), cand({ id: 'b' })], 0)
    const rows = dd.root.querySelectorAll('.ui-completion-dropdown__row')
    rows[1].dispatchEvent(new MouseEvent('mouseenter'))
    expect(onHover).toHaveBeenCalledWith(1)
    rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(onPick).toHaveBeenCalledWith(0)
  })

  it('hide clears rows and closes', () => {
    const { dd } = mount()
    dd.show([cand({})], 0)
    dd.hide()
    expect(dd.isOpen).toBe(false)
    expect(dd.root.querySelectorAll('.ui-completion-dropdown__row')).toHaveLength(0)
  })

  it('showEmpty renders one non-selectable row, no footer, and reports open', () => {
    const { dd } = mount()
    dd.showEmpty('No subdirectories in Downloads')
    expect(dd.isOpen).toBe(true)
    expect(dd.root.dataset.open).toBe('true')
    const rows = dd.root.querySelectorAll('.ui-completion-dropdown__row')
    expect(rows).toHaveLength(1)
    const row = rows[0] as HTMLElement
    expect(row.dataset.empty).toBe('true')
    expect(row.getAttribute('aria-selected')).toBe('false')
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).toContain('No subdirectories in Downloads')
    // No hint footer: the hints describe a selectable list.
    expect(dd.root.querySelector('.ui-completion-dropdown__footer')).toBeNull()
  })

  it('sizes to the longest row, capped — never the pane', () => {
    const { dd, container } = mount()
    Object.defineProperty(container, 'clientWidth', { value: 1200 })
    // jsdom reports scrollWidth 0, so fake it on the prototype — each show()
    // mints a fresh list element, so a per-element property would be lost.
    // The own property is deleted afterwards, restoring the chain getter.
    const proto = HTMLElement.prototype
    const fakeScrollWidth = (v: number) =>
      Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => v })
    try {
      fakeScrollWidth(0)
      dd.show([cand({ id: 'a' })], 0)
      // The floor applies to a tiny (here, unmeasurable) list.
      expect(dd.root.style.width).toBe(`${MIN_DROPDOWN_WIDTH_PX}px`)
      fakeScrollWidth(500)
      dd.show([cand({ id: 'b' })], 0)
      // The panel follows its longest row…
      expect(dd.root.style.width).toBe('500px')
      fakeScrollWidth(5000)
      dd.show([cand({ id: 'c' })], 0)
      // …but never past the cap.
      expect(dd.root.style.width).toBe(`${MAX_DROPDOWN_WIDTH_PX}px`)
    } finally {
      delete (proto as { scrollWidth?: number }).scrollWidth
    }
  })

  it('anchors at the caret, clamped inside the editor', () => {
    const { dd, container } = mount()
    Object.defineProperty(container, 'clientWidth', { value: 800 })
    dd.show([cand({ id: 'a' })], 0, 100)
    // jsdom reports offsetWidth 0, so the anchor is the left edge itself.
    expect(dd.root.style.left).toBe('100px')
    // An anchor past the right edge clamps so the panel stays inside.
    dd.show([cand({ id: 'b' })], 0, 5000)
    expect(dd.root.style.left).toBe('800px')
    // No anchor (a view-less surface) keeps the kit's default.
    dd.show([cand({ id: 'c' })], 0)
    expect(dd.root.style.left).toBe('')
  })

  it('hide clears the empty row too', () => {
    const { dd } = mount()
    dd.showEmpty('No matches')
    dd.hide()
    expect(dd.isOpen).toBe(false)
    expect(dd.root.querySelectorAll('.ui-completion-dropdown__row')).toHaveLength(0)
  })
})
