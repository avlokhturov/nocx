// @vitest-environment jsdom
// CompletionDropdown — the kit component's contract: it renders candidates,
// reports hover/pick, and never inserts anything itself (displayText is what
// a row shows; insertText belongs to the controller).
import { describe, it, expect, vi } from 'vitest'
import { CompletionDropdown } from './completion-dropdown'
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
})
