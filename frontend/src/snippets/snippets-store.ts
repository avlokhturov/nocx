// The one list every surface reads. There is no change notification on the
// wire (design §6): one window, one client, and every writer is a surface
// inside it — so a mutation re-reads rather than being pushed.
import type { SnippetsList } from '../generated/snippets.list'

export type Snippet = SnippetsList['snippets'][number]

/** The subset of SnippetsClient the store needs — declared so tests can
 *  substitute a fake without a WebSocket. */
export interface SnippetsClientLike {
  list(): Promise<{ snippets: Snippet[] }>
  create(title: string, body: string): Promise<Snippet>
  update(id: string, title: string, body: string): Promise<Snippet>
  remove(id: string): Promise<{ id: string }>
  reorder(ids: string[]): Promise<{ snippets: Snippet[] }>
}

export type SnippetsState =
  | { kind: 'loading' }
  | { kind: 'ready'; snippets: readonly Snippet[] }
  | { kind: 'unavailable'; message: string }

export class SnippetsStore {
  private current: SnippetsState = { kind: 'loading' }
  private subscribers = new Set<(s: SnippetsState) => void>()
  /** Monotonic: each refresh() claims the next generation, and only the
   *  latest may write state. A response (success or failure) whose
   *  generation is no longer current is discarded — a stale read must never
   *  overwrite a newer one. */
  private generation = 0

  constructor(private readonly client: SnippetsClientLike) {}

  state(): SnippetsState {
    return this.current
  }

  subscribe(cb: (s: SnippetsState) => void): () => void {
    this.subscribers.add(cb)
    cb(this.current)
    return () => this.subscribers.delete(cb)
  }

  private set(next: SnippetsState): void {
    this.current = next
    for (const cb of this.subscribers) cb(next)
  }

  /** Re-read the library. A failure is `unavailable` with the reason — never
   *  `ready` with an empty list, which would tell the user they have no
   *  snippets when in fact we could not look (design §11.5). */
  async refresh(): Promise<void> {
    this.started = true
    const gen = ++this.generation
    try {
      const res = await this.client.list()
      if (gen !== this.generation) return
      this.set({ kind: 'ready', snippets: res.snippets })
    } catch (err) {
      if (gen !== this.generation) return
      this.set({ kind: 'unavailable', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** True once a read has been asked for — `ensureLoaded` is a no-op after
   *  that, so a surface that asks on every keystroke (the completion
   *  provider) cannot turn typing into a wire call per key. */
  private started = false

  /** Read the library if nobody has yet. A surface that only DISPLAYS the
   *  list (the dropdown) uses this; a surface the person opened
   *  deliberately (the palette, the menu, the settings page) calls
   *  refresh(), because they are looking at it now and it must be current
   *  (design §6 — a writer re-reads, nothing is pushed). */
  ensureLoaded(): void {
    if (this.started) return
    this.started = true
    void this.refresh()
  }

  async create(title: string, body: string): Promise<void> {
    await this.client.create(title, body)
    await this.refresh()
  }

  async update(id: string, title: string, body: string): Promise<void> {
    await this.client.update(id, title, body)
    await this.refresh()
  }

  async remove(id: string): Promise<void> {
    await this.client.remove(id)
    await this.refresh()
  }

  async reorder(ids: string[]): Promise<void> {
    await this.client.reorder(ids)
    await this.refresh()
  }
}
