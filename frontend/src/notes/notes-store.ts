// The one list every notes surface reads. There is no change notification
// on the wire — one window, one client, and every writer is a surface
// inside it — so a mutation re-reads rather than being pushed. The same
// shape SnippetsStore has, for the same reason.
import type { NoteRow as ListRow } from '../generated/notes.list'
import type { NoteRow as SearchRow } from '../generated/notes.search'
import type { NotesGet } from '../generated/notes.get'

/** A row is the same shape whichever method answered — the list's and the
 *  search's are declared separately by the generator (one file per result),
 *  and naming both here is what says they are one concept. */
export type NoteRow = ListRow & SearchRow
export type Note = NotesGet

/** The subset of NotesClient the store needs — declared so a test can
 *  substitute a fake without a WebSocket. */
export interface NotesClientLike {
  list(): Promise<{ notes: NoteRow[] }>
  get(id: string): Promise<Note>
  create(body?: string): Promise<Note>
  update(id: string, body: string): Promise<Note>
  remove(id: string): Promise<{ id: string }>
  search(query: string): Promise<{ matches: NoteRow[] }>
}

export type NotesState =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: readonly NoteRow[] }
  /** The read failed. NEVER 'ready' with an empty list: telling somebody
   *  they have no notes when we could not look is the failure this whole
   *  feature would be judged by (design §8). */
  | { kind: 'unavailable'; message: string }

export class NotesStore {
  private current: NotesState = { kind: 'loading' }
  private subscribers = new Set<(s: NotesState) => void>()
  /** Monotonic: each read claims the next generation, and only the latest
   *  may write state. A stale answer — a slow list overtaken by a search,
   *  a search overtaken by the next keystroke — is discarded. */
  private generation = 0
  private started = false

  constructor(private readonly client: NotesClientLike) {}

  state(): NotesState {
    return this.current
  }

  subscribe(cb: (s: NotesState) => void): () => void {
    this.subscribers.add(cb)
    cb(this.current)
    return () => this.subscribers.delete(cb)
  }

  private set(next: NotesState): void {
    this.current = next
    for (const cb of this.subscribers) cb(next)
  }

  private failed(err: unknown): void {
    this.set({ kind: 'unavailable', message: err instanceof Error ? err.message : String(err) })
  }

  /** Read the library if nobody has yet — for a surface that only displays
   *  it. A surface somebody opened deliberately calls refresh(). */
  ensureLoaded(): void {
    if (this.started) return
    void this.refresh()
  }

  /** Re-read the whole list. */
  async refresh(): Promise<void> {
    this.started = true
    const gen = ++this.generation
    try {
      const res = await this.client.list()
      if (gen !== this.generation) return
      this.set({ kind: 'ready', rows: res.notes })
    } catch (err) {
      if (gen !== this.generation) return
      this.failed(err)
    }
  }

  /** Replace the list with what matched. The BACKEND searches; an empty
   *  query goes back to the plain list rather than asking for everything. */
  async search(query: string): Promise<void> {
    this.started = true
    if (query.trim() === '') {
      await this.refresh()
      return
    }
    const gen = ++this.generation
    try {
      const res = await this.client.search(query)
      if (gen !== this.generation) return
      this.set({ kind: 'ready', rows: res.matches })
    } catch (err) {
      if (gen !== this.generation) return
      this.failed(err)
    }
  }

  /** The note itself, for the editor. Deliberately NOT cached: the store
   *  holds the list, and a second copy of a body would be a second draft of
   *  it (AD-6 — the backend is the authority, the editor holds one draft). */
  get(id: string): Promise<Note> {
    return this.client.get(id)
  }

  async create(body = ''): Promise<Note> {
    const created = await this.client.create(body)
    await this.refresh()
    return created
  }

  async update(id: string, body: string): Promise<Note> {
    const updated = await this.client.update(id, body)
    await this.refresh()
    return updated
  }

  async remove(id: string): Promise<void> {
    await this.client.remove(id)
    await this.refresh()
  }
}
