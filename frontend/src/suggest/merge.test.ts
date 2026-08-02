// @vitest-environment node
// Merge rules (design §8.9.2): first results render as they arrive, a late
// arrival may not move the selection, the same candidate from two providers
// dedups by id, and one provider's error never kills the others (the
// controller catches per provider — merge itself has no error channel).
import { describe, it, expect } from 'vitest'
import { mergeCandidates, preserveSelection } from './merge'
import type { Candidate } from './candidate'

const cand = (id: string, providerId = 'p', text = id): Candidate => ({
  id,
  targetId: 'shell',
  providerId,
  displayText: text,
  insertText: text,
  replacement: { from: 0, to: 1 },
  matchRanges: [{ from: 0, to: 1 }],
  source: 'command',
  eligibleForGhostText: true,
})

describe('mergeCandidates', () => {
  it('appends new ids after existing ones', () => {
    const merged = mergeCandidates([cand('a'), cand('b')], [cand('c')])
    expect(merged.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('dedups by id — the later arrival replaces the earlier', () => {
    const fresh = { ...cand('a'), freshness: 200 }
    const stale = { ...cand('a'), freshness: 100 }
    const merged = mergeCandidates([stale], [fresh])
    expect(merged).toHaveLength(1)
    expect(merged[0].freshness).toBe(200)
  })

  it('dedups across providers when the id agrees', () => {
    const merged = mergeCandidates([cand('cmd:git', 'command')], [cand('cmd:git', 'history')])
    expect(merged).toHaveLength(1)
    expect(merged[0].providerId).toBe('history') // later arrival wins
  })

  it('keeps distinct ids from different providers', () => {
    const merged = mergeCandidates([cand('cmd:git', 'command')], [cand('hist:git', 'history')])
    expect(merged).toHaveLength(2)
  })

  it('returns a new array and never mutates its inputs', () => {
    const first = [cand('a')]
    const second = [cand('b')]
    const merged = mergeCandidates(first, second)
    expect(merged).not.toBe(first)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
  })
})

describe('preserveSelection', () => {
  it('keeps the selected candidate selected when it survives the merge', () => {
    const before = [cand('a'), cand('b'), cand('c')]
    const after = mergeCandidates(before, [cand('d'), cand('e')])
    // Selected 'c' (index 2); new arrivals append below it.
    expect(preserveSelection({ selectedIndex: 2, candidates: before }, after)).toBe(2)
  })

  it('a late arrival may not move the selection — it tracks the id, not the index', () => {
    const before = [cand('x'), cand('y'), cand('z')]
    // A new candidate ranks above 'y' (inserted at the front): the list
    // shifts, but the selected candidate must stay selected.
    const after = [cand('new'), ...before]
    expect(preserveSelection({ selectedIndex: 1, candidates: before }, after)).toBe(2)
  })

  it('clamps when the selected candidate disappeared', () => {
    const before = [cand('a'), cand('b'), cand('c')]
    const after = [cand('a')]
    expect(preserveSelection({ selectedIndex: 2, candidates: before }, after)).toBe(0)
  })

  it('stays at the index when nothing was selected yet', () => {
    expect(preserveSelection({ selectedIndex: 0, candidates: [] }, [cand('a')])).toBe(0)
  })

  it('an empty result leaves the selection at 0', () => {
    expect(preserveSelection({ selectedIndex: 2, candidates: [cand('a')] }, [])).toBe(0)
  })
})
