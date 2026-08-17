import { describe, expect, it } from 'vitest'
import { leftRunningMessage, liveDescendants, type LineageNode } from './lineage'

// The renderer's half of D6 (nocx-wtv3p): which live tabs descend from this
// one, and the sentence that NAMES them. The walk is what a close prompt is
// built on, so the cases that matter are the ones where a wrong answer would
// let a person close a tab believing nothing was left running, or hang the UI
// on the way to asking.

const node = (
  sessionId: string,
  parentSessionId: string | null,
  label = sessionId,
): LineageNode => ({
  sessionId,
  parentSessionId,
  label,
})

describe('liveDescendants', () => {
  it('finds children and grandchildren, closest first', () => {
    const nodes = [
      node('root', null),
      node('child-a', 'root'),
      node('child-b', 'root'),
      node('grandchild', 'child-a'),
    ]

    expect(liveDescendants('root', nodes).map((n) => n.sessionId)).toEqual([
      'child-a',
      'child-b',
      'grandchild',
    ])
  })

  it('never reports a tab that is not a descendant', () => {
    const nodes = [node('root', null), node('stranger', null), node('cousin', 'stranger')]

    expect(liveDescendants('root', nodes)).toEqual([])
  })

  it('never reports the tab itself, or its ancestors', () => {
    const nodes = [node('grandparent', null), node('parent', 'grandparent'), node('me', 'parent')]

    expect(liveDescendants('me', nodes)).toEqual([])
  })

  // A tab that has already gone is not something a close leaves running, so
  // it is not in `nodes` — and its children are then unreachable, which is
  // the honest answer: this question is only asked to describe open tabs.
  it('reports only tabs that are open', () => {
    const nodes = [node('root', null), node('grandchild', 'closed-child')]

    expect(liveDescendants('root', nodes)).toEqual([])
  })

  // The backend refuses to admit a cycle, but what is walked here is whatever
  // this renderer's acks accumulated — and a question asked on the close path
  // may not be able to hang the UI, whatever arrives in it.
  it('terminates on a cycle instead of hanging the close path', () => {
    const nodes = [node('a', 'b'), node('b', 'a')]

    expect(liveDescendants('a', nodes).map((n) => n.sessionId)).toEqual(['b'])
  })
})

describe('leftRunningMessage', () => {
  it('names the tabs and says they keep running', () => {
    const msg = leftRunningMessage([node('s1', 'root', 'repos/nocx'), node('s2', 'root', 'web-1')])

    expect(msg).toContain('repos/nocx')
    expect(msg).toContain('web-1')
    expect(msg).toContain('2 tabs')
    expect(msg).toMatch(/leaves them running/)
  })

  it('counts one tab as one', () => {
    expect(leftRunningMessage([node('s1', 'root', 'deploy')])).toContain('1 tab still running')
  })

  // The prompt must NAME them; past a handful a list stops being readable, so
  // it names the closest and counts the rest rather than either truncating
  // silently or printing a wall.
  it('names the closest and counts the rest when there are many', () => {
    const many = Array.from({ length: 8 }, (_, i) => node(`s${i}`, 'root', `tab-${i}`))
    const msg = leftRunningMessage(many)

    expect(msg).toContain('tab-0')
    expect(msg).toContain('tab-4')
    expect(msg).not.toContain('tab-5')
    expect(msg).toContain('and 3 more')
    expect(msg).toContain('8 tabs')
  })

  // The one thing this sentence may never offer. Closing the descendants with
  // their parent is the decision D6 forbids: three of the four ways to lose a
  // parent are failures, and even the fourth is an act about the parent.
  it('never offers to close the descendants too', () => {
    const msg = leftRunningMessage([node('s1', 'root', 'deploy')]).toLowerCase()

    expect(msg).not.toContain('close them')
    expect(msg).not.toContain('close all')
  })
})
