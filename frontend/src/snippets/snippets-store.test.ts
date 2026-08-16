import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../dispatcher'
import type { Snippet as ListSnippet, SnippetsList } from '../generated/snippets.list'
import type { Snippet as ReorderSnippet } from '../generated/snippets.reorder'
import { SnippetsClient } from './snippets-client'
import { SnippetsStore, type Snippet, type SnippetsClientLike } from './snippets-store'

const LIST: SnippetsList = { snippets: [{ id: 'a', title: 't', body: 'b' }] }
// The fixtures are typed with the generated Snippet declarations and the
// store's — each of the three is a real consumer, so the ratchet counts
// them (the client imports the result types, but knip does not follow a
// type into an interface member).
const SNIP_A: Snippet = { id: 'a', title: 'old', body: 'stale' }
const SNIP_B: ListSnippet = { id: 'b', title: 'new', body: 'fresh' }
const REORDERED: ReorderSnippet = { id: 'c', title: 're', body: 'rr' }

function fakeClient(over: Partial<SnippetsClientLike> = {}): SnippetsClientLike {
  return {
    list: vi.fn().mockResolvedValue(LIST),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
    ...over,
  }
}

/** A promise the test resolves by hand, to order two list calls deliberately. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SnippetsStore', () => {
  // A failed list is 'unavailable' with the reason, NEVER 'ready' with an
  // empty list: an empty library and a library we could not look at must be
  // distinguishable by every surface (design §11.5).
  it('reports unavailable when the list call fails, never an empty library', async () => {
    const store = new SnippetsStore(
      fakeClient({ list: vi.fn().mockRejectedValue(new Error('nope')) }),
    )
    await store.refresh()
    const s = store.state()
    expect(s.kind).toBe('unavailable')
    if (s.kind === 'unavailable') expect(s.message).toContain('nope')
  })

  // The paired success: an empty library IS readable, and reads as [] — the
  // state a "you have none" surface shows, not the reason a failure shows.
  it('an empty library is ready with no snippets, distinct from unavailable', async () => {
    const store = new SnippetsStore(
      fakeClient({ list: vi.fn().mockResolvedValue({ snippets: [] }) }),
    )
    await store.refresh()
    expect(store.state()).toEqual({ kind: 'ready', snippets: [] })
  })

  it('becomes ready with the returned list', async () => {
    const store = new SnippetsStore(fakeClient())
    await store.refresh()
    expect(store.state()).toEqual({ kind: 'ready', snippets: LIST.snippets })
  })

  // There is no change notification on the wire (design §6): a mutation
  // re-reads the library, never guessing the new order.
  it('re-reads the library after every mutation rather than guessing', async () => {
    const list = vi.fn().mockResolvedValue(LIST)
    const client = fakeClient({
      list,
      create: vi.fn().mockResolvedValue(LIST.snippets[0]),
      update: vi.fn().mockResolvedValue(LIST.snippets[0]),
      remove: vi.fn().mockResolvedValue({ id: 'a' }),
      reorder: vi.fn().mockResolvedValue({ snippets: [REORDERED] }),
    })
    const store = new SnippetsStore(client)
    await store.refresh()
    expect(list).toHaveBeenCalledTimes(1)
    await store.create('t', 'b')
    await store.update('a', 't', 'b')
    await store.remove('a')
    await store.reorder(['a'])
    expect(list).toHaveBeenCalledTimes(5)
    expect(store.state()).toEqual({ kind: 'ready', snippets: LIST.snippets })
  })

  // Every mutation has a rejection test (AGENTS.md rule 3): the mutation
  // rejects carrying the reason, the visible list is unchanged, and no
  // re-read happened for a write that never landed.
  it.each([
    { name: 'create', act: (s: SnippetsStore) => s.create('t', 'b') },
    { name: 'update', act: (s: SnippetsStore) => s.update('a', 't', 'b') },
    { name: 'remove', act: (s: SnippetsStore) => s.remove('a') },
    { name: 'reorder', act: (s: SnippetsStore) => s.reorder(['a']) },
  ])('$name failure: visible list unchanged, the reason carried', async ({ name, act }) => {
    const fail = vi.fn().mockRejectedValue(new Error(`boom-${name}`))
    const list = vi.fn().mockResolvedValue(LIST)
    const client = fakeClient({
      list,
      create: fail,
      update: fail,
      remove: fail,
      reorder: fail,
    })
    const store = new SnippetsStore(client)
    await store.refresh()
    await expect(act(store)).rejects.toThrow(`boom-${name}`)
    expect(store.state()).toEqual({ kind: 'ready', snippets: LIST.snippets })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('calls a new subscriber with the current state immediately', async () => {
    const store = new SnippetsStore(fakeClient())
    await store.refresh()
    const seen: string[] = []
    store.subscribe((s) => seen.push(s.kind))
    expect(seen).toEqual(['ready'])
  })

  it('notifies subscribers on every transition, current state first', async () => {
    const store = new SnippetsStore(fakeClient())
    const seen: string[] = []
    store.subscribe((s) => seen.push(s.kind))
    expect(seen).toEqual(['loading'])
    await store.refresh()
    expect(seen).toEqual(['loading', 'ready'])
  })

  // The plan's race, through the mutation path: mutation A's refresh and
  // mutation B's refresh overlap, and A's list resolves LAST. A started a
  // read that no longer speaks for the store — its result must be
  // discarded, not applied over the newer one.
  it('a stale refresh from an earlier mutation cannot overwrite a newer one', async () => {
    const first = deferred<SnippetsList>()
    const second = deferred<SnippetsList>()
    const list = vi
      .fn()
      .mockResolvedValueOnce(LIST)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const client = fakeClient({
      list,
      update: vi.fn().mockResolvedValue(LIST.snippets[0]),
      remove: vi.fn().mockResolvedValue({ id: 'a' }),
    })
    const store = new SnippetsStore(client)
    await store.refresh()
    const m1 = store.update('a', 't', 'b')
    const m2 = store.remove('a')
    second.resolve({ snippets: [SNIP_B] })
    await m2
    expect(store.state()).toEqual({ kind: 'ready', snippets: [SNIP_B] })
    first.resolve({ snippets: [SNIP_A] })
    await m1
    expect(store.state()).toEqual({ kind: 'ready', snippets: [SNIP_B] })
  })

  // Same generation guard, other side: a STALE failure must not clobber a
  // newer success — an old read failing is not news about the current list.
  it('a stale refresh that fails cannot clobber a newer success', async () => {
    const first = deferred<SnippetsList>()
    const second = deferred<SnippetsList>()
    const list = vi
      .fn()
      .mockResolvedValueOnce(LIST)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const client = fakeClient({
      list,
      update: vi.fn().mockResolvedValue(LIST.snippets[0]),
      remove: vi.fn().mockResolvedValue({ id: 'a' }),
    })
    const store = new SnippetsStore(client)
    await store.refresh()
    const m1 = store.update('a', 't', 'b')
    const m2 = store.remove('a')
    second.resolve({ snippets: [SNIP_B] })
    await m2
    expect(store.state()).toEqual({ kind: 'ready', snippets: [SNIP_B] })
    first.reject(new Error('stale failure'))
    await m1
    expect(store.state()).toEqual({ kind: 'ready', snippets: [SNIP_B] })
  })
})

describe('SnippetsClient', () => {
  // The client is the renderer's half of the wire contract: one method per
  // call, exact params, results typed by the generated schemas. This is the
  // consumer that replaces the scaffolding test (snippets.contract.test.ts).
  it('maps each method to its wire call and params', async () => {
    const calls: Array<[string, unknown]> = []
    const dispatcher = {
      call: vi.fn((method: string, params: unknown) => {
        calls.push([method, params])
        return Promise.resolve({})
      }),
    } as unknown as Dispatcher
    const client = new SnippetsClient(dispatcher)
    await client.list()
    await client.create('Title', 'body text')
    await client.update('id-1', 'Title', 'body text')
    await client.remove('id-1')
    await client.reorder(['id-1', 'id-2'])
    expect(calls).toEqual([
      ['snippets.list', {}],
      ['snippets.create', { title: 'Title', body: 'body text' }],
      ['snippets.update', { id: 'id-1', title: 'Title', body: 'body text' }],
      ['snippets.delete', { id: 'id-1' }],
      ['snippets.reorder', { ids: ['id-1', 'id-2'] }],
    ])
  })

  // Rule 3, client side: the one external call the client makes is
  // dispatcher.call, shared by every method — a rejection must propagate
  // untouched, so the caller (the store, then the surface) sees the reason.
  it('propagates a rejected wire call — no error handling hides it', async () => {
    const dispatcher = {
      call: vi.fn(() => Promise.reject(new Error('ws closed'))),
    } as unknown as Dispatcher
    const client = new SnippetsClient(dispatcher)
    await expect(client.list()).rejects.toThrow('ws closed')
  })
})

describe('ensureLoaded — the read a display surface asks for (nocx-nlhe)', () => {
  it('reads the library once, however many times it is asked', async () => {
    const list = vi.fn().mockResolvedValue({ snippets: [] })
    const store = new SnippetsStore(fakeClient({ list }))

    store.ensureLoaded()
    store.ensureLoaded()
    store.ensureLoaded()
    await vi.waitFor(() => {
      expect(store.state().kind).toBe('ready')
    })
    store.ensureLoaded()

    // The completion provider calls this on every keystroke: one read for
    // an unread library, and never a wire call per key.
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('does not re-read after a refresh has already asked', async () => {
    const list = vi.fn().mockResolvedValue({ snippets: [] })
    const store = new SnippetsStore(fakeClient({ list }))
    await store.refresh()
    store.ensureLoaded()
    expect(list).toHaveBeenCalledTimes(1)
  })
})
