import { describe, expect, it, vi } from 'vitest'
import { NotesStore, type NoteRow, type NotesClientLike } from './notes-store'
import type { NotesGet } from '../generated/notes.get'
import type { NotesCreate } from '../generated/notes.create'
import type { NotesUpdate } from '../generated/notes.update'
import type { NotesDelete } from '../generated/notes.delete'
import type { NotesSearch } from '../generated/notes.search'

const ROW: NoteRow = { id: 'a', title: 'Deploy', excerpt: 'kubectl rollout', updatedAt: 10 }
const NOTE: NotesGet = {
  id: 'a',
  title: 'Deploy',
  body: 'Deploy\nkubectl rollout',
  createdAt: 1,
  updatedAt: 10,
}
// The fixtures are typed with the GENERATED declarations, one per method —
// each is a real consumer, so the dead-export ratchet counts them (the
// client imports the result types, but knip does not follow a type into an
// interface member). The same reason snippets-store.test.ts does this.
const CREATED: NotesCreate = { id: 'b', title: '', body: '', createdAt: 2, updatedAt: 2 }
const UPDATED: NotesUpdate = {
  id: 'a',
  title: 'edited',
  body: 'edited',
  createdAt: 1,
  updatedAt: 11,
}
const DELETED: NotesDelete = { id: 'a' }
const FOUND: NotesSearch = { matches: [ROW] }

/** The client plus its spies, kept separately: reading a method OFF the
 *  object to assert on it is an unbound reference the lint rule refuses,
 *  and it is the same shape the snippets tests use. */
function fakeClient(over: Partial<NotesClientLike> = {}) {
  const spies = {
    list: vi.fn().mockResolvedValue({ notes: [ROW] }),
    get: vi.fn().mockResolvedValue(NOTE),
    create: vi.fn().mockResolvedValue(CREATED),
    update: vi.fn().mockResolvedValue(UPDATED),
    remove: vi.fn().mockResolvedValue(DELETED),
    search: vi.fn().mockResolvedValue({ ...FOUND, matches: [] }),
  }
  const client: NotesClientLike = { ...spies, ...over }
  return { client, spies }
}

/** A promise the test resolves by hand, to order two reads deliberately. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('NotesStore', () => {
  it('a failed list is unavailable WITH the reason, never an empty library', async () => {
    // The failure this feature would be judged by: telling somebody they
    // have no notes when we could not look (design §8).
    const store = new NotesStore(
      fakeClient({ list: vi.fn().mockRejectedValue(new Error('disk is gone')) }).client,
    )
    await store.refresh()
    const state = store.state()
    expect(state.kind).toBe('unavailable')
    expect(state.kind === 'unavailable' && state.message).toContain('disk is gone')
  })

  it('a stale read cannot overwrite a newer one', async () => {
    const slow = deferred<{ notes: NoteRow[] }>()
    const fast = deferred<{ notes: NoteRow[] }>()
    const list = vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
    const store = new NotesStore(fakeClient({ list }).client)

    const first = store.refresh()
    const second = store.refresh()
    // The SECOND answer lands first, then the first one arrives late.
    fast.resolve({ notes: [{ ...ROW, id: 'newer' }] })
    await second
    slow.resolve({ notes: [{ ...ROW, id: 'older' }] })
    await first

    const state = store.state()
    expect(state.kind === 'ready' && state.rows[0].id).toBe('newer')
  })

  it('a write re-reads: there is no change notification on the wire', async () => {
    const { client, spies } = fakeClient()
    const store = new NotesStore(client)
    await store.create('hello')
    expect(spies.list).toHaveBeenCalledTimes(1)
    await store.update('a', 'edited')
    expect(spies.list).toHaveBeenCalledTimes(2)
    await store.remove('a')
    expect(spies.list).toHaveBeenCalledTimes(3)
  })

  it('search asks the BACKEND, and an empty query goes back to the list', async () => {
    const search = vi.fn().mockResolvedValue({ matches: [{ ...ROW, id: 'hit' }] })
    const { client, spies } = fakeClient({ search })
    const store = new NotesStore(client)

    await store.search('rollout')
    expect(search).toHaveBeenCalledWith('rollout')
    expect(store.state()).toMatchObject({ kind: 'ready', rows: [{ id: 'hit' }] })

    await store.search('   ')
    // Not a search for everything: the plain list is what "no query" means.
    expect(search).toHaveBeenCalledTimes(1)
    expect(spies.list).toHaveBeenCalledTimes(1)
  })

  it('a failed search says so, and does not leave the old rows looking like results', async () => {
    const store = new NotesStore(
      fakeClient({ search: vi.fn().mockRejectedValue(new Error('index is gone')) }).client,
    )
    await store.refresh()
    await store.search('anything')
    expect(store.state().kind).toBe('unavailable')
  })

  it('ensureLoaded reads once, however many times it is asked', async () => {
    const { client, spies } = fakeClient()
    const store = new NotesStore(client)
    store.ensureLoaded()
    store.ensureLoaded()
    await vi.waitFor(() => {
      expect(store.state().kind).toBe('ready')
    })
    store.ensureLoaded()
    expect(spies.list).toHaveBeenCalledTimes(1)
  })

  it('get is not cached: the editor holds the one draft, the backend holds the note', async () => {
    const { client, spies } = fakeClient()
    const store = new NotesStore(client)
    await store.get('a')
    await store.get('a')
    expect(spies.get).toHaveBeenCalledTimes(2)
  })
})
