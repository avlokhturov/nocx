// FilesTreeStore — unit tests for the four rules that make the tree correct:
// root immobility (rule 1), origin-scoped staleness with per-node generation
// ordering (rule 2), canonical cycle detection before rendering (rule 3) and
// the state discriminator (rule 4). The store is exercised directly with a
// fake services seam — no DOM, no WebSocket.
import { describe, expect, it, vi } from 'vitest'
import type { FilesListEntry, FilesListResult } from '../generated/files.list'
import type { FilesPanelServices } from './files-client'
import { createFilesTreeStore, FILES_PAGE_SIZE, type FilesTreeStore } from './files-store'
import type { ActiveOrigin } from '../tab-content'

// ── Fixtures ──────────────────────────────────────────────────────────────

const LOCAL_A: ActiveOrigin = {
  tabId: 1,
  sessionId: 'session-a',
  kind: 'local',
  cwd: '/home/alice',
  cwdVerified: true,
  host: null,
}

const SSH_B: ActiveOrigin = {
  tabId: 2,
  sessionId: 'session-b',
  kind: 'ssh',
  cwd: '/home/bob',
  cwdVerified: false,
  host: 'srv-b',
}

const OPEN_RESULT = {
  bindingId: 'b1',
  endpointId: null,
  root: { path: '/home/alice', display: '~/alice', inferred: false, inferredReason: '' },
}

const entry = (over: Partial<FilesListEntry>): FilesListEntry => ({
  name: 'file',
  path: '/home/alice/file',
  kind: 'regular',
  size: 0,
  modTime: '2026-08-06T00:00:00Z',
  mode: 0o644,
  ...over,
})

const listOk = (
  canonical: string,
  entries: FilesListEntry[],
  over: Partial<FilesListResult & { state: 'ok' }> = {},
): FilesListResult => ({
  state: 'ok',
  path: '/home/alice',
  canonical,
  entries,
  offset: 0,
  total: entries.length,
  hasMore: false,
  rev: 'r1',
  ...over,
})

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeServices(over: Partial<FilesPanelServices> = {}): FilesPanelServices {
  return {
    open: vi.fn().mockResolvedValue(OPEN_RESULT),
    list: vi.fn().mockResolvedValue(listOk('C:/home/alice', [])),
    read: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue({}),
    ...over,
  }
}

/** Drain the microtask queue until the store's promise chains settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function nodeRows(store: FilesTreeStore, name: string) {
  const row = store.rows().find((r) => r.kind === 'entry' && r.node.name === name)
  if (!row || row.kind !== 'entry') throw new Error(`no row named ${name}`)
  return row.node
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('files tree store', () => {
  it('opens a binding for the origin and lists the root', async () => {
    const open = vi.fn().mockResolvedValue(OPEN_RESULT)
    const list = vi
      .fn()
      .mockResolvedValue(
        listOk('C:/home/alice', [entry({ name: 'a.txt' }), entry({ name: 'docs', kind: 'dir' })]),
      )
    const store = createFilesTreeStore(makeServices({ open, list }))
    store.rescope(LOCAL_A)
    await settle()

    expect(store.phase()).toBe('ready')
    expect(open).toHaveBeenCalledWith('session-a', '/home/alice')
    expect(list).toHaveBeenCalledWith('b1', '/home/alice', 0, FILES_PAGE_SIZE)
    const names = store
      .rows()
      .filter((r) => r.kind === 'entry')
      .map((r) => (r.kind === 'entry' ? r.node.name : ''))
    expect(names).toEqual(['a.txt', 'docs'])
  })

  it('omits rootPath when the cwd is not verified (D2)', async () => {
    const open = vi.fn().mockResolvedValue(OPEN_RESULT)
    const store = createFilesTreeStore(makeServices({ open }))
    store.rescope({ ...LOCAL_A, cwdVerified: false })
    await settle()
    expect(open).toHaveBeenCalledWith('session-a')
  })

  it('does not re-open or re-root when the same session re-scopes (rule 1)', async () => {
    const open = vi.fn().mockResolvedValue(OPEN_RESULT)
    const list = vi.fn().mockResolvedValue(listOk('C:/home/alice', [entry({ name: 'a.txt' })]))
    const store = createFilesTreeStore(makeServices({ open, list }))
    store.rescope(LOCAL_A)
    await settle()

    // A later OSC 7 cwd on the SAME session must not re-root the tree.
    store.rescope({ ...LOCAL_A, cwd: '/home/alice/elsewhere' })
    await settle()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('a different tab re-scopes: old binding closed, new one opened', async () => {
    const open = vi.fn().mockResolvedValue(OPEN_RESULT)
    const close = vi.fn().mockResolvedValue({})
    const store = createFilesTreeStore(makeServices({ open, close }))
    store.rescope(LOCAL_A)
    await settle()
    store.rescope(SSH_B)
    await settle()

    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenLastCalledWith('session-b')
    expect(close).toHaveBeenCalledWith('b1')
  })

  it('a viewer tab answering its source session keeps the binding (design §5.4)', async () => {
    // TabManager composes the ACTIVE tab's id into the origin, so a viewer
    // tab opened from tab A answers tab A's session with a NEW tabId. Same
    // machine: the binding must stay open — closing it would kill the
    // viewer's in-flight read and render "source unavailable" for a file
    // that was read successfully (the fm-w12 defect).
    const open = vi.fn().mockResolvedValue(OPEN_RESULT)
    const close = vi.fn().mockResolvedValue({})
    const store = createFilesTreeStore(makeServices({ open, close }))
    store.rescope(LOCAL_A)
    await settle()

    store.rescope({ ...LOCAL_A, tabId: 99 })
    await settle()

    expect(open).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    expect(store.phase()).toBe('ready')
  })

  it('expanding a directory reaches files.list and commits its entries', async () => {
    const list = vi
      .fn()
      .mockImplementation((bindingId: string, path: string) =>
        Promise.resolve(
          path === '/home/alice'
            ? listOk('C:/home/alice', [
                entry({ name: 'docs', path: '/home/alice/docs', kind: 'dir' }),
              ])
            : listOk('C:/home/alice/docs', [
                entry({ name: 'notes.md', path: '/home/alice/docs/notes.md' }),
              ]),
        ),
      )
    const store = createFilesTreeStore(makeServices({ list }))
    store.rescope(LOCAL_A)
    await settle()

    const docs = nodeRows(store, 'docs')
    store.toggle(docs)
    await settle()

    expect(list).toHaveBeenCalledWith('b1', '/home/alice/docs', 0, FILES_PAGE_SIZE)
    const names = store
      .rows()
      .filter((r) => r.kind === 'entry')
      .map((r) => (r.kind === 'entry' ? r.node.name : ''))
    expect(names).toEqual(['docs', 'notes.md'])
  })

  it('"show next" fetches the next page and reveals the rest (D10)', async () => {
    const first = entry({ name: 'f1' })
    const list = vi.fn().mockImplementation((bindingId: string, path: string, offset: number) =>
      Promise.resolve(
        offset === 0
          ? listOk('C:/home/alice', [first], {
              total: 3,
              hasMore: true,
              rev: 'r1',
              path: '/home/alice',
            })
          : listOk('C:/home/alice', [entry({ name: 'f2' }), entry({ name: 'f3' })], {
              offset: 1,
              total: 3,
              hasMore: false,
              rev: 'r1',
              path: '/home/alice',
            }),
      ),
    )
    const store = createFilesTreeStore(makeServices({ list }))
    store.rescope(LOCAL_A)
    await settle()

    expect(store.rows().filter((r) => r.kind === 'entry')).toHaveLength(1)
    expect(store.rows().some((r) => r.kind === 'more')).toBe(true)

    const more = store.rows().find((r) => r.kind === 'more')
    if (!more || more.kind !== 'more') throw new Error('no more row')
    store.showMore(more.dir)
    await settle()

    expect(list).toHaveBeenCalledWith('b1', '/home/alice', 1, FILES_PAGE_SIZE)
    const names = store
      .rows()
      .filter((r) => r.kind === 'entry')
      .map((r) => (r.kind === 'entry' ? r.node.name : ''))
    expect(names).toEqual(['f1', 'f2', 'f3'])
    expect(store.rows().some((r) => r.kind === 'more')).toBe(false)
  })

  // ── Rule 2: the §0 test, at the store's level ──────────────────────────
  it('drops a listing for tab A that resolves after the user activated tab B', async () => {
    const aRootList = deferred<FilesListResult>()
    const list = vi
      .fn()
      .mockResolvedValueOnce(aRootList.promise) // A's root listing, still in flight
      .mockResolvedValueOnce(
        listOk('C:/home/bob', [entry({ name: 'b-only.txt', path: '/home/bob/b-only.txt' })]),
      )
    const store = createFilesTreeStore(makeServices({ list }))
    store.rescope(LOCAL_A)
    await settle() // A's binding opens; A's root list hangs

    store.rescope(SSH_B)
    await settle() // B's binding opens; B's root list applies

    // A's listing finally lands — it must not paint A's machine into B's tree.
    aRootList.resolve(
      listOk('C:/home/alice', [entry({ name: 'a-only.txt', path: '/home/alice/a-only.txt' })]),
    )
    await settle()

    const names = store
      .rows()
      .filter((r) => r.kind === 'entry')
      .map((r) => (r.kind === 'entry' ? r.node.name : ''))
    expect(names).toEqual(['b-only.txt'])
    expect(names).not.toContain('a-only.txt')
  })

  it('drops a response older than what has already been applied to the same node', async () => {
    const oldExpand = deferred<FilesListResult>()
    const refreshList = deferred<FilesListResult>()
    const docsEntry = entry({ name: 'docs', path: '/home/alice/docs', kind: 'dir' })
    let docsLists = 0
    const list = vi.fn().mockImplementation((bindingId: string, path: string) => {
      if (path === '/home/alice') return Promise.resolve(listOk('C:/home/alice', [docsEntry]))
      docsLists += 1
      // First docs list = the expand (gen 1, hangs); second = the refresh
      // re-list (gen 2, hangs) — refresh() also re-lists the root, so the
      // mock must key on the path, not on call order.
      return docsLists === 1 ? oldExpand.promise : refreshList.promise
    })
    const store = createFilesTreeStore(makeServices({ list }))
    store.rescope(LOCAL_A)
    await settle()

    const docs = nodeRows(store, 'docs')
    store.toggle(docs)
    await settle() // the expand is in flight

    store.refresh() // supersedes the expand: generation bumps, docs re-listed
    await settle()

    // The NEWER response lands first and is applied...
    refreshList.resolve(
      listOk('C:/home/alice/docs', [entry({ name: 'new.md', path: '/home/alice/docs/new.md' })], {
        path: '/home/alice/docs',
      }),
    )
    await settle()

    // ...then the OLD expand lands: the generation is older than what was
    // applied, so its page must not overwrite the fresh listing.
    oldExpand.resolve(
      listOk('C:/home/alice/docs', [entry({ name: 'old.md', path: '/home/alice/docs/old.md' })], {
        path: '/home/alice/docs',
      }),
    )
    await settle()

    const names = store
      .rows()
      .filter((r) => r.kind === 'entry')
      .map((r) => (r.kind === 'entry' ? r.node.name : ''))
    expect(names).toEqual(['docs', 'new.md'])
    expect(names).not.toContain('old.md')
  })

  // ── Rule 3: cycle detection ────────────────────────────────────────────
  it('marks a symlink whose canonical matches an expanded ancestor cyclic and lists nothing', async () => {
    const list = vi.fn().mockImplementation((bindingId: string, path: string) =>
      Promise.resolve(
        path === '/home/alice'
          ? listOk('C:/home/alice', [
              entry({
                name: 'loop',
                path: '/home/alice/loop',
                kind: 'symlink',
                linkKind: 'dir',
                linkTarget: '/',
              }),
            ])
          : listOk('C:/home/alice', [entry({ name: 'leak.md', path: '/leak.md' })]),
      ),
    )
    const store = createFilesTreeStore(makeServices({ list }))
    store.rescope(LOCAL_A)
    await settle()

    const loop = nodeRows(store, 'loop')
    store.toggle(loop)
    await settle()

    expect(loop.cyclic).toBe(true)
    expect(loop.expanded).toBe(false)
    // No children were committed — the listing never flashed.
    const names = store
      .rows()
      .filter((r) => r.kind === 'entry')
      .map((r) => (r.kind === 'entry' ? r.node.name : ''))
    expect(names).toEqual(['loop'])

    // It is never requested again.
    const loopLists = list.mock.calls.filter(([, path]) => path === '/home/alice/loop')
    expect(loopLists).toHaveLength(1)
    store.toggle(loop)
    await settle()
    expect(list.mock.calls.filter(([, path]) => path === '/home/alice/loop')).toHaveLength(1)
  })

  it('detects a cycle against a non-parent ancestor (root) too', async () => {
    const list = vi.fn().mockImplementation((bindingId: string, path: string) => {
      if (path === '/home/alice')
        return Promise.resolve(
          listOk('C:root', [entry({ name: 'sub', path: '/home/alice/sub', kind: 'dir' })]),
        )
      if (path === '/home/alice/sub')
        return Promise.resolve(
          listOk('C:sub', [
            entry({
              name: 'up',
              path: '/home/alice/sub/up',
              kind: 'symlink',
              linkKind: 'dir',
              linkTarget: '/',
            }),
          ]),
        )
      // up resolves to the ROOT's canonical — an expanded ancestor that is
      // not its parent.
      return Promise.resolve(listOk('C:root', [entry({ name: 'root-child' })]))
    })
    const store = createFilesTreeStore(makeServices({ list }))
    store.rescope(LOCAL_A)
    await settle()

    const sub = nodeRows(store, 'sub')
    store.toggle(sub)
    await settle()

    const up = nodeRows(store, 'up')
    store.toggle(up)
    await settle()

    expect(up.cyclic).toBe(true)
    expect(
      store
        .rows()
        .filter((r) => r.kind === 'entry')
        .map((r) => (r.kind === 'entry' ? r.node.name : '')),
    ).toEqual(['sub', 'up'])
  })

  // ── Rule 4: the state discriminator ────────────────────────────────────
  it('renders tooLarge as a real state with no pagination offered (D14)', async () => {
    const list = vi
      .fn()
      .mockImplementation((bindingId: string, path: string) =>
        Promise.resolve(
          path === '/home/alice'
            ? listOk('C:/home/alice', [
                entry({ name: 'big', path: '/home/alice/big', kind: 'dir' }),
              ])
            : { state: 'tooLarge' as const, observedCount: 12_345, limit: 1_000 },
        ),
      )
    const store = createFilesTreeStore(makeServices({ list }))
    store.rescope(LOCAL_A)
    await settle()

    const big = nodeRows(store, 'big')
    store.toggle(big)
    await settle()

    expect(big.state).toBe('tooLarge')
    expect(big.tooLargeLimit).toBe(1_000)
    expect(big.observedCount).toBe(12_345)
    expect(big.children).toHaveLength(0)
    expect(big.hasMore).toBe(false)
    expect(store.rows().some((r) => r.kind === 'state')).toBe(true)
    expect(store.rows().some((r) => r.kind === 'more')).toBe(false)
  })

  it('renders timedOut as its own state and retries the same enumeration', async () => {
    let calls = 0
    const list = vi.fn().mockImplementation((bindingId: string, path: string) => {
      calls += 1
      if (path === '/home/alice')
        return Promise.resolve(
          listOk('C:/home/alice', [entry({ name: 'slow', path: '/home/alice/slow', kind: 'dir' })]),
        )
      return calls === 2
        ? Promise.resolve({ state: 'timedOut' as const, timeout: 5_000 })
        : Promise.resolve(listOk('C:/home/alice/slow', [entry({ name: 'x.md' })]))
    })
    const store = createFilesTreeStore(makeServices({ list }))
    store.rescope(LOCAL_A)
    await settle()

    const slow = nodeRows(store, 'slow')
    store.toggle(slow)
    await settle()

    expect(slow.state).toBe('timedOut')
    expect(slow.timeout).toBe(5_000)
    expect(slow.children).toHaveLength(0)

    store.retry(slow)
    await settle()
    expect(slow.state).toBe('ok')
    expect(
      store
        .rows()
        .filter((r) => r.kind === 'entry')
        .map((r) => (r.kind === 'entry' ? r.node.name : '')),
    ).toEqual(['slow', 'x.md'])
  })

  it('a rejected list is a rendered error state, never a silent empty directory', async () => {
    const list = vi
      .fn()
      .mockImplementation((bindingId: string, path: string) =>
        Promise.resolve(
          path === '/home/alice'
            ? listOk('C:/home/alice', [
                entry({ name: 'secret', path: '/home/alice/secret', kind: 'dir' }),
              ])
            : Promise.reject(new Error('permission denied')),
        ),
      )
    const store = createFilesTreeStore(makeServices({ list }))
    store.rescope(LOCAL_A)
    await settle()

    const secret = nodeRows(store, 'secret')
    store.toggle(secret)
    await settle()

    expect(secret.state).toBe('error')
    expect(secret.error).toContain('permission denied')
    expect(secret.children).toHaveLength(0)
  })

  it('a tooLarge ROOT is a state too', async () => {
    const list = vi.fn().mockResolvedValue({ state: 'tooLarge' as const, limit: 1_000 })
    const store = createFilesTreeStore(makeServices({ list }))
    store.rescope(LOCAL_A)
    await settle()

    expect(store.phase()).toBe('ready')
    const stateRows = store.rows().filter((r) => r.kind === 'state')
    expect(stateRows).toHaveLength(1)
    if (stateRows[0]?.kind !== 'state') throw new Error('no state row')
    expect(stateRows[0].dir.state).toBe('tooLarge')
  })

  it('dispose closes the binding and resets; a later rescope re-opens', async () => {
    const close = vi.fn().mockResolvedValue({})
    const store = createFilesTreeStore(makeServices({ close }))
    store.rescope(LOCAL_A)
    await settle()
    expect(store.phase()).toBe('ready')

    store.dispose()
    expect(close).toHaveBeenCalledWith('b1')
    expect(store.phase()).toBe('no-origin')
    expect(store.rows()).toHaveLength(0)

    store.rescope(SSH_B)
    await settle()
    expect(store.phase()).toBe('ready')
    expect(close).toHaveBeenCalledTimes(1)
  })
})
