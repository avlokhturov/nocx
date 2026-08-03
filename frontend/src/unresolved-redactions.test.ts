// @vitest-environment jsdom
//
// The unresolved-redaction StateField (unresolved-redactions.ts): spans map
// through subsequent edits, a span wholly replaced (a resolution, a
// deletion of the mask) collapses and leaves the list, and the host can
// replace the whole set with the set effect. The full-replacement collapse
// is the acceptance-critical half: without it, resolving a chip would map
// the span ONTO the inserted {{secret:NAME}} reference and the unresolved
// chip would keep rendering over the resolved one.
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { unresolvedRedactionField, setUnresolvedSpans } from './unresolved-redactions'
import type { UnresolvedSpan } from './unresolved-redactions'

const span = (from: number, to: number): UnresolvedSpan => ({ from, to, kind: 'openai' })

function stateWith(doc: string, spans: UnresolvedSpan[]): EditorState {
  return EditorState.create({
    doc,
    extensions: [unresolvedRedactionField],
  }).update({ effects: setUnresolvedSpans.of(spans) }).state
}

describe('the unresolved-redaction field', () => {
  it('maps a span through an ordinary edit before it: text typed earlier shifts the mask', () => {
    const st = stateWith('curl sk-p...7890', [span(5, 16)])
    const next = st.update({ changes: { from: 0, insert: 'echo ' } }).state
    expect(next.field(unresolvedRedactionField)).toEqual([span(10, 21)])
  })

  it('shrinks a span when text is edited inside it', () => {
    const st = stateWith('curl sk-p...7890', [span(5, 16)])
    const next = st.update({ changes: { from: 6, to: 9, insert: 'x' } }).state
    const after = next.field(unresolvedRedactionField)
    expect(after.length).toBe(1)
    expect(after[0].from).toBe(5)
    expect(after[0].to).toBe(14)
  })

  it('collapses a span WHOLY replaced by the change — the resolution case — and drops it', () => {
    const st = stateWith('curl sk-p...7890', [span(5, 16)])
    const next = st.update({
      changes: { from: 5, to: 16, insert: '{{secret:openrouter.ai}}' },
    }).state
    expect(next.field(unresolvedRedactionField)).toEqual([])
  })

  it('collapses a span deleted by the change', () => {
    const st = stateWith('curl sk-p...7890', [span(5, 16)])
    const next = st.update({ changes: { from: 5, to: 16, insert: '' } }).state
    expect(next.field(unresolvedRedactionField)).toEqual([])
  })

  it('keeps a span that only overlaps a replaced range (a partial edit) mapped, not collapsed', () => {
    const st = stateWith('curl sk-p...7890', [span(5, 16)])
    const next = st.update({ changes: { from: 5, to: 8, insert: 'x' } }).state
    const after = next.field(unresolvedRedactionField)
    expect(after.length).toBe(1)
    // The change is 3 chars shorter; the span maps to the net shift.
    expect(after[0]).toEqual({ from: 5, to: 14, kind: 'openai' })
  })

  it('the set effect replaces the whole list', () => {
    const st = stateWith('one two three', [span(0, 3), span(4, 7)])
    const next = st.update({ effects: setUnresolvedSpans.of([span(8, 13)]) }).state
    expect(next.field(unresolvedRedactionField)).toEqual([span(8, 13)])
  })
})
