// SnippetsClient — the snippets.* control-plane seam. One method per wire
// call, every result a GENERATED type: the renderer declares nothing of its
// own, because a hand-written type can want a field the wire does not carry.
import type { Dispatcher } from '../dispatcher'
import type { SnippetsList } from '../generated/snippets.list'
import type { SnippetsCreate } from '../generated/snippets.create'
import type { SnippetsUpdate } from '../generated/snippets.update'
import type { SnippetsDelete } from '../generated/snippets.delete'
import type { SnippetsReorder } from '../generated/snippets.reorder'

export class SnippetsClient {
  constructor(private dispatcher: Dispatcher) {}

  list(): Promise<SnippetsList> {
    return this.dispatcher.call<SnippetsList>('snippets.list', {})
  }

  /** No id parameter, deliberately: the backend mints it (design §5.1). */
  create(title: string, body: string): Promise<SnippetsCreate> {
    return this.dispatcher.call<SnippetsCreate>('snippets.create', { title, body })
  }

  update(id: string, title: string, body: string): Promise<SnippetsUpdate> {
    return this.dispatcher.call<SnippetsUpdate>('snippets.update', { id, title, body })
  }

  remove(id: string): Promise<SnippetsDelete> {
    return this.dispatcher.call<SnippetsDelete>('snippets.delete', { id })
  }

  /** The FULL id list; the backend rejects anything that is not a
   *  permutation and answers with the order it stored. */
  reorder(ids: string[]): Promise<SnippetsReorder> {
    return this.dispatcher.call<SnippetsReorder>('snippets.reorder', { ids })
  }
}
