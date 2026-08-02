// @vitest-environment node
// Provider contracts (design §8.5): applicability is part of the contract —
// a provider declares where it applies and is not consulted outside it. The
// local path provider must be inactive on a remote session, and the command
// provider must answer from the running shell's own snapshot.
import { describe, it, expect, vi } from 'vitest'
import { CommandSnapshotStore } from '../command-snapshot'
import { commandProvider, historyProvider, fsProvider, type SuggestContext } from './providers'
import type { HistoryQuery } from '../generated/history.query'
import type { FsComplete } from '../generated/fs.complete'

const ctx = (over: Partial<SuggestContext> = {}): SuggestContext => ({
  doc: 'git sta',
  token: { text: 'sta', from: 4, to: 7 },
  position: 'argument',
  isLocal: true,
  cwd: '/repo',
  host: '',
  ...over,
})

const snapshotted = (names: string[]): CommandSnapshotStore => {
  const store = new CommandSnapshotStore()
  const nonce = 'a'.repeat(32)
  store.ingest(`H;${nonce}`)
  store.ingest(`S;${nonce};${names.join(';')}`)
  return store
}
describe('commandProvider', () => {
  const provider = commandProvider(snapshotted(['git', 'gitk', 'gittool']))

  it('is applicable in command position for a bare word', () => {
    expect(
      provider.applicable(ctx({ position: 'command', token: { text: 'git', from: 0, to: 3 } })),
    ).toBe(true)
  })

  it('is not applicable in argument position', () => {
    expect(provider.applicable(ctx({ position: 'argument' }))).toBe(false)
  })

  it('is not applicable for a token containing a slash (a path invocation)', () => {
    expect(
      provider.applicable(ctx({ position: 'command', token: { text: './run', from: 0, to: 5 } })),
    ).toBe(false)
  })

  it('answers names from the snapshot, prefix-filtered', async () => {
    const got = await provider.suggest(
      ctx({ position: 'command', token: { text: 'git', from: 0, to: 3 }, doc: 'git' }),
      new AbortController().signal,
    )
    expect(got.map((c) => c.insertText)).toEqual(['git', 'gitk', 'gittool'])
    expect(got[0].id).toBe('cmd:git')
    expect(got[0].replacement).toEqual({ from: 0, to: 3 })
    expect(got[0].matchRanges).toEqual([{ from: 0, to: 3 }])
    expect(got[0].eligibleForGhostText).toBe(true)
  })

  it('an empty snapshot answers nothing', async () => {
    const empty = commandProvider(snapshotted([]))
    const got = await empty.suggest(
      ctx({ position: 'command', token: { text: 'git', from: 0, to: 3 }, doc: 'git' }),
      new AbortController().signal,
    )
    expect(got).toEqual([])
  })
})

describe('historyProvider', () => {
  it('completes the whole line from history, newest first, deduped', async () => {
    const query = vi.fn((): Promise<HistoryQuery> =>
      Promise.resolve({
        scope: 'directory',
        exhausted: true,
        source: 'store',
        // The store's horizon (nocx-ms7v.9). Null is the honest value for a
        // fixture: this test is about ranking, not about retention.
        coverage: null,
        entries: [
          {
            id: '2',
            command: 'git status',
            cwd: '/repo',
            host: '',
            status: 'success',
            endedAt: 200,
          },
          {
            id: '1',
            command: 'git status',
            cwd: '/repo',
            host: '',
            status: 'failure',
            endedAt: 100,
          },
          {
            id: '3',
            command: 'git stash pop',
            cwd: '/repo',
            host: '',
            status: 'success',
            endedAt: 300,
          },
          { id: '4', command: 'ls -la', cwd: '/repo', host: '', status: 'success', endedAt: 400 },
        ],
      }),
    )
    const provider = historyProvider({ query })
    const got = await provider.suggest(ctx({ doc: 'git sta' }), new AbortController().signal)

    expect(query).toHaveBeenCalledWith('/repo', '')
    // Only commands starting with the line; the duplicate `git status` keeps
    // the newest row (freshness 200), and the line itself is the replacement.
    expect(got.map((c) => c.insertText)).toEqual(['git status', 'git stash pop'])
    expect(got[0].freshness).toBe(200)
    expect(got[0].replacement).toEqual({ from: 0, to: 7 })
    expect(got[0].outcome).toEqual({ status: 'success' })
    expect(got[0].environment?.confidence).toBe('asserted')
  })

  it('is applicable even with a trailing space (the line is non-empty)', () => {
    const provider = historyProvider({ query: vi.fn() })
    expect(provider.applicable(ctx({ doc: 'git ', token: { text: '', from: 4, to: 4 } }))).toBe(
      true,
    )
  })

  it('is not applicable on an empty line', () => {
    const provider = historyProvider({ query: vi.fn() })
    expect(provider.applicable(ctx({ doc: '', token: { text: '', from: 0, to: 0 } }))).toBe(false)
  })

  it('answers nothing when the store errors (one provider never kills the others)', async () => {
    const provider = historyProvider({
      query: vi.fn(() => Promise.reject(new Error('store down'))),
    })
    await expect(provider.suggest(ctx({}), new AbortController().signal)).rejects.toThrow(
      'store down',
    )
  })
})

describe('fsProvider', () => {
  const complete = vi.fn((text: string): Promise<FsComplete> =>
    Promise.resolve(
      text === './sr'
        ? { entries: [{ name: 'src', path: '/repo/src', isDir: true }] }
        : { entries: [] },
    ),
  )

  const provider = fsProvider({ complete })

  it('is applicable for a local session and a path-looking token', () => {
    expect(provider.applicable(ctx({ token: { text: './sr', from: 3, to: 7 } }))).toBe(true)
    expect(provider.applicable(ctx({ token: { text: '~/Doc', from: 0, to: 5 } }))).toBe(true)
    expect(provider.applicable(ctx({ token: { text: '/usr/lo', from: 0, to: 7 } }))).toBe(true)
  })

  it('is NEVER applicable on a remote session — a local path must not masquerade as a remote one', () => {
    expect(
      provider.applicable(ctx({ isLocal: false, token: { text: './sr', from: 3, to: 7 } })),
    ).toBe(false)
  })

  it('is not applicable for a bare word (a command name, not a path)', () => {
    expect(provider.applicable(ctx({ token: { text: 'src', from: 3, to: 6 } }))).toBe(false)
    expect(provider.applicable(ctx({ token: { text: '', from: 4, to: 4 } }))).toBe(false)
  })

  it('maps backend entries to candidates with display, match and slash-for-dirs', async () => {
    const got = await provider.suggest(
      ctx({ doc: 'cd ./sr', token: { text: './sr', from: 3, to: 7 } }),
      new AbortController().signal,
    )
    expect(complete).toHaveBeenCalledWith('./sr', '/repo')
    expect(got).toHaveLength(1)
    const c = got[0]
    expect(c.displayText).toBe('./src/')
    expect(c.insertText).toBe('./src/')
    expect(c.id).toBe('fs:/repo/src')
    expect(c.replacement).toEqual({ from: 3, to: 7 })
    // The matched prefix `sr` sits inside the completed name (`./src/`).
    expect(c.matchRanges).toEqual([{ from: 2, to: 4 }])
    expect(c.source).toBe('path')
    expect(c.eligibleForGhostText).toBe(true)
  })

  it('answers nothing on a provider error', async () => {
    const failing = fsProvider({
      complete: vi.fn(() => Promise.reject(new Error('no such dir'))),
    })
    await expect(
      failing.suggest(
        ctx({ token: { text: './sr', from: 3, to: 7 } }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('no such dir')
  })
})
