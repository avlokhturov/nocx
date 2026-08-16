// NotesClient — the notes.* control-plane seam. One method per wire call,
// every result a GENERATED type: the renderer declares nothing of its own,
// because a hand-written type can want a field the wire does not carry
// (which is exactly how vault.status shipped a field nobody sent).
import type { Dispatcher } from '../dispatcher'
import type { NotesList } from '../generated/notes.list'
import type { NotesGet } from '../generated/notes.get'
import type { NotesCreate } from '../generated/notes.create'
import type { NotesUpdate } from '../generated/notes.update'
import type { NotesDelete } from '../generated/notes.delete'
import type { NotesSearch } from '../generated/notes.search'

export class NotesClient {
  constructor(private dispatcher: Dispatcher) {}

  /** Rows: a title and an excerpt each, never the bodies (design §5). */
  list(): Promise<NotesList> {
    return this.dispatcher.call<NotesList>('notes.list', {})
  }

  /** The whole note — what the editor opens with. */
  get(id: string): Promise<NotesGet> {
    return this.dispatcher.call<NotesGet>('notes.get', { id })
  }

  /** No id parameter, deliberately: the backend mints it and both stamps.
   *  An empty body is ordinary — the chord opens a note to type into. */
  create(body = ''): Promise<NotesCreate> {
    return this.dispatcher.call<NotesCreate>('notes.create', { body })
  }

  update(id: string, body: string): Promise<NotesUpdate> {
    return this.dispatcher.call<NotesUpdate>('notes.update', { id, body })
  }

  remove(id: string): Promise<NotesDelete> {
    return this.dispatcher.call<NotesDelete>('notes.delete', { id })
  }

  /** Search runs on the BACKEND: the index is there, and a filter over a
   *  loaded list would mean loading every note to look inside it. */
  search(query: string): Promise<NotesSearch> {
    return this.dispatcher.call<NotesSearch>('notes.search', { query })
  }
}
