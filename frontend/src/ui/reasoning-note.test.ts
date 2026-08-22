// @vitest-environment jsdom
//
// ReasoningNote (ui/reasoning-note.ts) — the kit contract, pinned: a native
// disclosure that starts CLOSED, a body that concatenates chunks without
// showing their boundaries, and nothing at all rendered for a model that
// thought nothing (which is the caller's job: the note is built at the first
// chunk, so a run with no reasoning never constructs one).
import { describe, it, expect } from 'vitest'
import { createReasoningNote } from './reasoning-note'

describe('ReasoningNote', () => {
  it('is a closed disclosure under the kit identity class', () => {
    const note = createReasoningNote()
    expect(note.el.classList.contains('ui-reasoning')).toBe(true)
    expect(note.el.tagName).toBe('DETAILS')
    expect((note.el as HTMLDetailsElement).open).toBe(false)
    expect(note.el.querySelector('.ui-reasoning__summary')?.textContent).toBe('Thinking')
  })

  it('concatenates chunks, so a split mid-word leaves no seam', () => {
    const note = createReasoningNote()
    note.append('the user asks about ')
    note.append('the screen')
    expect(note.el.querySelector('.ui-reasoning__body')?.textContent).toBe(
      'the user asks about the screen',
    )
  })

  it('ignores an empty chunk rather than growing the body with nothing', () => {
    const note = createReasoningNote()
    note.append('')
    expect(note.el.querySelector('.ui-reasoning__body')?.textContent).toBe('')
  })
})
