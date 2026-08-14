import { describe, expect, it } from 'vitest'

import type { SnippetsCreate } from './snippets.create'
import type { SnippetsDelete } from './snippets.delete'
import type { Snippet as ListSnippet, SnippetsList } from './snippets.list'
import type { Snippet as ReorderSnippet, SnippetsReorder } from './snippets.reorder'
import type { SnippetsUpdate } from './snippets.update'

// The generated wire types are the renderer's half of the contract; their
// production consumers arrive with the snippets client task. Until then,
// importing and exercising them here keeps the dead-exports ratchet honest:
// the exports are reachable, and when the client lands this test shrinks
// away rather than the baseline growing.
describe('generated snippets wire types', () => {
  it('shape the results the schemas declare', () => {
    const list: SnippetsList = { snippets: [] }
    const created: SnippetsCreate = { id: 'id-1', title: 't', body: 'b' }
    const updated: SnippetsUpdate = { id: 'id-1', title: 't', body: 'b' }
    const deleted: SnippetsDelete = { id: 'id-1' }
    const reordered: SnippetsReorder = { snippets: [] }
    const listOne: ListSnippet = created
    const reorderOne: ReorderSnippet = created
    expect([
      list.snippets.length,
      created.id,
      updated.body,
      deleted.id,
      reordered.snippets.length,
      listOne.title,
      reorderOne.body,
    ]).toEqual([0, 'id-1', 'b', 'id-1', 0, 't', 'b'])
  })
})
