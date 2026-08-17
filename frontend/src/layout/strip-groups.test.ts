import { describe, expect, it } from 'vitest'
import { groupStrip, workspaceAxis, type GroupAxis } from './strip-groups'

/** A row is whatever the strip draws; the mechanism never looks inside one. */
interface Row {
  id: string
  workspaceId: string
  kind: string
}

const row = (id: string, workspaceId: string, kind = 'local'): Row => ({ id, workspaceId, kind })

const DEFAULT_WS = 'workspace:default'

/** The second axis, standing in for nocx-jv3q.1's: the SAME mechanism with a
 *  different key and a different heading. If this file ever needs a second
 *  grouping implementation to express it, the mechanism has been forked. */
const kindAxis: GroupAxis<Row> = {
  key: (r) => r.kind,
  heading: (key) => (key === 'local' ? 'Local' : 'SSH'),
}

describe('groupStrip — one heading mechanism, the axis is an input', () => {
  it('cuts the rows into groups in first-appearance order, keeping the order within each', () => {
    const rows = [row('a', 'ws-1'), row('b', DEFAULT_WS), row('c', 'ws-1')]
    const axis = workspaceAxis(
      [{ id: 'ws-1', name: 'refactor-auth' }],
      DEFAULT_WS,
      (r: Row) => r.workspaceId,
    )

    const groups = groupStrip(rows, axis)

    expect(groups.map((g) => g.key)).toEqual(['ws-1', DEFAULT_WS])
    expect(groups[0].rows.map((r) => r.id)).toEqual(['a', 'c'])
    expect(groups[1].rows.map((r) => r.id)).toEqual(['b'])
  })

  it('takes a different axis over the same rows and answers with different groups', () => {
    const rows = [row('a', 'ws-1', 'ssh'), row('b', DEFAULT_WS, 'local'), row('c', 'ws-1', 'local')]

    const groups = groupStrip(rows, kindAxis)

    expect(groups.map((g) => g.heading)).toEqual(['SSH', 'Local'])
    expect(groups[1].rows.map((r) => r.id)).toEqual(['b', 'c'])
  })

  it('answers nothing for no rows — an empty strip has no headings to draw', () => {
    expect(groupStrip([], kindAxis)).toEqual([])
  })
})

describe('workspaceAxis — the default workspace draws no heading, ever', () => {
  const named = [
    { id: 'ws-1', name: 'refactor-auth' },
    { id: 'ws-2', name: 'ansible-rollout' },
  ]
  const axis = (workspaces: readonly { id: string; name: string }[]) =>
    workspaceAxis(workspaces, DEFAULT_WS, (r: Row) => r.workspaceId)

  it('gives the default no heading when it is the only workspace', () => {
    const groups = groupStrip([row('a', DEFAULT_WS)], axis([]))

    expect(groups.map((g) => g.heading)).toEqual([null])
  })

  it('STILL gives the default no heading once other workspaces exist', () => {
    // The rule this asserts is "not a counter": the default's chrome is what
    // it is because it is the default, never because of how many workspaces
    // there are. `heading` is handed ONE key and cannot see the set, so this
    // is a property of the signature and not of an implementation branch.
    const rows = [row('a', DEFAULT_WS), row('b', 'ws-1'), row('c', 'ws-2')]

    const groups = groupStrip(rows, axis(named))

    expect(groups.find((g) => g.key === DEFAULT_WS)?.heading).toBeNull()
    expect(groups.find((g) => g.key === 'ws-1')?.heading).toBe('refactor-auth')
    expect(groups.find((g) => g.key === 'ws-2')?.heading).toBe('ansible-rollout')
  })

  it('never renders the name the backend stores for the default row', () => {
    // The default HAS a row and that row has a name in the database. It is
    // never read: the default acquires no name in the product, whatever the
    // store calls it.
    const groups = groupStrip(
      [row('a', DEFAULT_WS)],
      axis([{ id: DEFAULT_WS, name: 'default' }, ...named]),
    )

    expect(groups[0].heading).toBeNull()
  })

  it('draws no heading for a workspace it has no name for, rather than inventing one', () => {
    const groups = groupStrip([row('a', 'ws-unknown')], axis(named))

    expect(groups[0].heading).toBeNull()
  })
})
