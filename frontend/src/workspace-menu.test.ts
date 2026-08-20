import { describe, expect, it, vi } from 'vitest'
import { moveWorkspace, workspaceActionRows, type WorkspaceSet } from './workspace-menu'

// The workspace action menu (nocx-isoph.7). These assert the RULES rather than
// the labels: which affordances exist for which workspace, and what a move
// actually sends — because the wire takes a whole permutation and refuses
// anything else.

const DEFAULT_WS = 'workspace:default'

function aSet(ids: string[]): WorkspaceSet {
  return { ids, defaultWorkspaceId: DEFAULT_WS }
}

function actions() {
  return { onRename: vi.fn(), onReorder: vi.fn(), onClose: vi.fn() }
}

describe('workspaceActionRows', () => {
  it('offers the default workspace nothing at all', () => {
    // Not a disabled row and not a row that refuses: the affordance does not
    // exist. The default has no name to change and cannot be closed.
    expect(workspaceActionRows(DEFAULT_WS, aSet([DEFAULT_WS, 'ws-1']), actions())).toEqual([])
  })

  it('offers rename and close for a named workspace', () => {
    const rows = workspaceActionRows('ws-1', aSet([DEFAULT_WS, 'ws-1']), actions())
    expect(rows.map((r) => r.id)).toContain('workspace-rename')
    expect(rows.map((r) => r.id)).toContain('workspace-close')
  })

  it('offers no move at the ends, and the right one in the middle', () => {
    const set = aSet(['ws-1', 'ws-2', 'ws-3'])
    expect(workspaceActionRows('ws-1', set, actions()).map((r) => r.id)).not.toContain(
      'workspace-up',
    )
    expect(workspaceActionRows('ws-3', set, actions()).map((r) => r.id)).not.toContain(
      'workspace-down',
    )
    const middle = workspaceActionRows('ws-2', set, actions()).map((r) => r.id)
    expect(middle).toContain('workspace-up')
    expect(middle).toContain('workspace-down')
  })

  it('sends the WHOLE new order when a move is chosen, not the moved member', () => {
    // content.ReorderWorkspaces refuses anything that is not a permutation of
    // what the store holds, so a row that sent one id would be refused every
    // time — and the refusal would arrive as a strip that did not move.
    const act = actions()
    const rows = workspaceActionRows('ws-2', aSet(['ws-1', 'ws-2', 'ws-3']), act)
    rows.find((r) => r.id === 'workspace-up')!.onSelect()
    expect(act.onReorder).toHaveBeenCalledWith(['ws-2', 'ws-1', 'ws-3'])
  })

  it('offers nothing for a workspace the set does not hold', () => {
    // A heading can outlive its row for one frame. Acting on it would send a
    // permutation the store refuses, so there is nothing to act with.
    expect(workspaceActionRows('ws-gone', aSet([DEFAULT_WS, 'ws-1']), actions())).toEqual([])
  })

  it('names the subject it was built for, not the current workspace', () => {
    // The vertical strip opens this menu per heading, so two headings must
    // produce two different subjects from one mechanism.
    const act = actions()
    const rows = workspaceActionRows('ws-3', aSet(['ws-1', 'ws-2', 'ws-3']), act)
    rows.find((r) => r.id === 'workspace-rename')!.onSelect()
    rows.find((r) => r.id === 'workspace-close')!.onSelect()
    expect(act.onRename).toHaveBeenCalledWith('ws-3')
    expect(act.onClose).toHaveBeenCalledWith('ws-3')
  })
})

describe('moveWorkspace', () => {
  it('refuses a move that would leave the set', () => {
    expect(moveWorkspace(['a', 'b'], 'a', -1)).toBeNull()
    expect(moveWorkspace(['a', 'b'], 'b', 1)).toBeNull()
  })

  it('refuses a workspace the set does not hold', () => {
    expect(moveWorkspace(['a', 'b'], 'c', 1)).toBeNull()
  })

  it('returns a permutation of the same members', () => {
    const moved = moveWorkspace(['a', 'b', 'c'], 'c', -1)!
    expect([...moved].sort()).toEqual(['a', 'b', 'c'])
    expect(moved).toEqual(['a', 'c', 'b'])
  })

  it('does not mutate the order it was given', () => {
    const ids = ['a', 'b', 'c']
    moveWorkspace(ids, 'a', 1)
    expect(ids).toEqual(['a', 'b', 'c'])
  })
})
