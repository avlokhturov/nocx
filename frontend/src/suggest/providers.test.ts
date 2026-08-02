// @vitest-environment node
// Provider contracts (design §8.5): applicability is part of the contract —
// a provider declares where it applies and is not consulted outside it. The
// local path provider must be inactive on a remote session, and the command
// provider must answer from the running shell's own snapshot.
import { describe, it, expect, vi } from 'vitest'
import {
  commandProvider,
  historyProvider,
  fsProvider,
  MAX_HISTORY_IN_ARGUMENT_POSITION,
  MAX_PROVIDER_CANDIDATES,
  type SuggestContext,
} from './providers'
import { CommandSnapshotStore } from '../command-snapshot'
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
    expect(got.candidates.map((c) => c.insertText)).toEqual(['git', 'gitk', 'gittool'])
    expect(got.candidates[0].id).toBe('cmd:git')
    expect(got.candidates[0].replacement).toEqual({ from: 0, to: 3 })
    expect(got.candidates[0].matchRanges).toEqual([{ from: 0, to: 3 }])
    expect(got.candidates[0].eligibleForGhostText).toBe(true)
  })

  it('an empty snapshot payload cannot apply — the store stays pending, named honestly', async () => {
    // The store rejects an empty name list ("every command is unknown" is a
    // lie), so the snapshot never applies and the provider must say the
    // snapshot is still pending rather than "no matches".
    const empty = commandProvider(snapshotted([]))
    const got = await empty.suggest(
      ctx({ position: 'command', token: { text: 'git', from: 0, to: 3 }, doc: 'git' }),
      new AbortController().signal,
    )
    expect(got.candidates).toEqual([])
    expect(got.emptyReason).toEqual({ kind: 'snapshot-pending' })
  })

  it('a snapshot that has not arrived yet is named, not hidden', async () => {
    // A fresh store: the OSC 636 hello and snapshot have not been ingested.
    const pending = commandProvider(new CommandSnapshotStore())
    const got = await pending.suggest(
      ctx({ position: 'command', token: { text: 'vi', from: 0, to: 2 }, doc: 'vi' }),
      new AbortController().signal,
    )
    expect(got.candidates).toEqual([])
    expect(got.emptyReason).toEqual({ kind: 'snapshot-pending' })
  })

  it('an empty token asks for nothing — no reason, the line has no intent yet', async () => {
    const pending = commandProvider(new CommandSnapshotStore())
    const got = await pending.suggest(
      ctx({ position: 'command', token: { text: '', from: 0, to: 0 }, doc: '' }),
      new AbortController().signal,
    )
    expect(got.candidates).toEqual([])
    expect(got.emptyReason).toBeUndefined()
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
    expect(got.candidates.map((c) => c.insertText)).toEqual(['git status', 'git stash pop'])
    expect(got.candidates[0].freshness).toBe(200)
    expect(got.candidates[0].replacement).toEqual({ from: 0, to: 7 })
    expect(got.candidates[0].outcome).toEqual({ status: 'success' })
    expect(got.candidates[0].environment?.confidence).toBe('asserted')
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

  it('argument position on a local session caps history so paths are never crowded', async () => {
    const many = Array.from({ length: MAX_PROVIDER_CANDIDATES + 5 }, (_, i) => ({
      id: String(i),
      command: `cd x${i}`,
      cwd: '/repo',
      host: '',
      status: 'success' as const,
      endedAt: 100 + i,
    }))
    const provider = historyProvider({
      query: vi.fn((): Promise<HistoryQuery> =>
        Promise.resolve({
          scope: 'directory',
          exhausted: true,
          source: 'store',
          coverage: null,
          entries: many,
        }),
      ),
    })
    const got = await provider.suggest(
      ctx({ doc: 'cd ', token: { text: '', from: 3, to: 3 } }),
      new AbortController().signal,
    )
    expect(got.candidates.length).toBe(MAX_HISTORY_IN_ARGUMENT_POSITION)
  })

  it('command position and remote sessions keep the full provider cap', async () => {
    const makeProvider = (prefix: string) => {
      const entries = Array.from({ length: MAX_PROVIDER_CANDIDATES + 5 }, (_, i) => ({
        id: `${prefix}-${i}`,
        command: `${prefix} x${i}`,
        cwd: '/repo',
        host: '',
        status: 'success' as const,
        endedAt: 100 + i,
      }))
      return historyProvider({
        query: vi.fn((): Promise<HistoryQuery> =>
          Promise.resolve({
            scope: 'directory',
            exhausted: true,
            source: 'store',
            coverage: null,
            entries,
          }),
        ),
      })
    }
    const inCommand = await makeProvider('git').suggest(
      ctx({ position: 'command', doc: 'git', token: { text: 'git', from: 0, to: 3 } }),
      new AbortController().signal,
    )
    expect(inCommand.candidates.length).toBe(MAX_PROVIDER_CANDIDATES)
    // Remote argument position: the path provider is inactive, so history is
    // the only answer — it keeps its full capacity rather than the
    // argument-position cap, which exists to stop history crowding paths.
    const onRemote = await makeProvider('cd').suggest(
      ctx({ isLocal: false, doc: 'cd ', token: { text: '', from: 3, to: 3 } }),
      new AbortController().signal,
    )
    expect(onRemote.candidates.length).toBe(MAX_PROVIDER_CANDIDATES)
  })

  it('a history row whose trailing token no longer exists is marked stalePath — demoted, never dropped', async () => {
    // The reported case: the user deleted the file, and the whole-line row
    // `rm zzz-e2e-cmp-msbojbc7` still matches the typed prefix.
    const completeFs = vi.fn((): Promise<FsComplete> => Promise.resolve({ entries: [] }))
    const provider = historyProvider({
      query: vi.fn((): Promise<HistoryQuery> =>
        Promise.resolve({
          scope: 'directory',
          exhausted: true,
          source: 'store',
          coverage: null,
          entries: [
            {
              id: '1',
              command: 'rm zzz-e2e-cmp-msbojbc7',
              cwd: '/repo',
              host: '',
              status: 'success',
              endedAt: 100,
            },
          ],
        }),
      ),
      completeFs,
    })
    const got = await provider.suggest(
      ctx({
        doc: 'rm zzz-e2e-cmp-msbojbc7',
        token: { text: 'zzz-e2e-cmp-msbojbc7', from: 3, to: 22 },
      }),
      new AbortController().signal,
    )
    // The row is still offered (demotion is not hiding)…
    expect(got.candidates).toHaveLength(1)
    // …but marked stale: the backend answered no entry named exactly the
    // token (soft-empty for a missing path), so the rank sinks it last.
    expect(got.candidates[0].stalePath).toBe(true)
    expect(completeFs).toHaveBeenCalledWith('zzz-e2e-cmp-msbojbc7', '/repo')
  })

  it('an exact entry-name match is existence — the row is not demoted', async () => {
    const completeFs = vi.fn((): Promise<FsComplete> =>
      Promise.resolve({
        entries: [
          { name: 'zzz-e2e-cmp-msbojbc7', path: '/repo/zzz-e2e-cmp-msbojbc7', isDir: false },
        ],
      }),
    )
    const provider = historyProvider({
      query: vi.fn((): Promise<HistoryQuery> =>
        Promise.resolve({
          scope: 'directory',
          exhausted: true,
          source: 'store',
          coverage: null,
          entries: [
            {
              id: '1',
              command: 'rm zzz-e2e-cmp-msbojbc7',
              cwd: '/repo',
              host: '',
              status: 'success',
              endedAt: 100,
            },
          ],
        }),
      ),
      completeFs,
    })
    const got = await provider.suggest(
      ctx({
        doc: 'rm zzz-e2e-cmp-msbojbc7',
        token: { text: 'zzz-e2e-cmp-msbojbc7', from: 3, to: 22 },
      }),
      new AbortController().signal,
    )
    expect(got.candidates[0].stalePath).toBeUndefined()
  })

  it('an option-looking trailing token is never checked (it is not a path)', async () => {
    const completeFs = vi.fn((): Promise<FsComplete> => Promise.resolve({ entries: [] }))
    const provider = historyProvider({
      query: vi.fn((): Promise<HistoryQuery> =>
        Promise.resolve({
          scope: 'directory',
          exhausted: true,
          source: 'store',
          coverage: null,
          entries: [
            {
              id: '1',
              command: 'ls -la',
              cwd: '/repo',
              host: '',
              status: 'success',
              endedAt: 100,
            },
          ],
        }),
      ),
      completeFs,
    })
    const got = await provider.suggest(
      ctx({ doc: 'ls -', token: { text: '-', from: 3, to: 4 } }),
      new AbortController().signal,
    )
    expect(got.candidates[0].stalePath).toBeUndefined()
    expect(completeFs).not.toHaveBeenCalled()
  })

  it('a remote session never calls the filesystem — "exists" cannot be known there', async () => {
    const completeFs = vi.fn((): Promise<FsComplete> => Promise.resolve({ entries: [] }))
    const provider = historyProvider({
      query: vi.fn((): Promise<HistoryQuery> =>
        Promise.resolve({
          scope: 'directory',
          exhausted: true,
          source: 'store',
          coverage: null,
          entries: [
            {
              id: '1',
              command: 'rm zzz-e2e-cmp-msbojbc7',
              cwd: '/repo',
              host: 'remote',
              status: 'success',
              endedAt: 100,
            },
          ],
        }),
      ),
      completeFs,
    })
    const got = await provider.suggest(
      ctx({
        isLocal: false,
        doc: 'rm zzz-e2e-cmp-msbojbc7',
        token: { text: 'zzz-e2e-cmp-msbojbc7', from: 3, to: 22 },
      }),
      new AbortController().signal,
    )
    expect(got.candidates[0].stalePath).toBeUndefined()
    expect(completeFs).not.toHaveBeenCalled()
  })

  it('one fs.complete call per token, cached for the life of the open list', async () => {
    const completeFs = vi.fn((): Promise<FsComplete> => Promise.resolve({ entries: [] }))
    const provider = historyProvider({
      query: vi.fn((): Promise<HistoryQuery> =>
        Promise.resolve({
          scope: 'directory',
          exhausted: true,
          source: 'store',
          coverage: null,
          entries: [
            {
              id: '1',
              command: 'rm zzz-e2e-cmp-msbojbc7',
              cwd: '/repo',
              host: '',
              status: 'success',
              endedAt: 100,
            },
          ],
        }),
      ),
      completeFs,
    })
    // Two queries within the same interaction (each document extends the
    // previous — the user typed more); the trailing token is unchanged.
    await provider.suggest(
      ctx({ doc: 'rm zzz', token: { text: 'zzz', from: 3, to: 6 } }),
      new AbortController().signal,
    )
    await provider.suggest(
      ctx({
        doc: 'rm zzz-e2e-cmp-msbojbc7',
        token: { text: 'zzz-e2e-cmp-msbojbc7', from: 3, to: 22 },
      }),
      new AbortController().signal,
    )
    expect(completeFs).toHaveBeenCalledTimes(1)
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

  it('is not applicable in command position for a bare word (a command name, not a path)', () => {
    expect(
      provider.applicable(ctx({ position: 'command', token: { text: 'src', from: 0, to: 3 } })),
    ).toBe(false)
  })

  it('is applicable in argument position for ANY token — including a bare word and the empty token', () => {
    // A bare word in argument position (`ls src`) is an argument, and the
    // argument may be a path — the path provider answers it.
    expect(provider.applicable(ctx({ token: { text: 'src', from: 3, to: 6 } }))).toBe(true)
    // The empty token (`cd ` + Tab) lists the session cwd.
    expect(provider.applicable(ctx({ token: { text: '', from: 4, to: 4 } }))).toBe(true)
  })

  it('an empty token lists the session cwd (the wire refuses empty text, so it asks for ./)', async () => {
    const complete = vi.fn((text: string): Promise<FsComplete> =>
      Promise.resolve(
        text === './'
          ? {
              entries: [
                { name: 'src', path: '/repo/src', isDir: true },
                { name: 'notes.txt', path: '/repo/notes.txt', isDir: false },
              ],
            }
          : { entries: [] },
      ),
    )
    const provider = fsProvider({ complete })
    const got = await provider.suggest(
      // `ls` keeps both kinds — this test is about the empty-token display,
      // and `cd` would filter the file out by the dirs-only rule.
      ctx({ doc: 'ls ', token: { text: '', from: 3, to: 3 } }),
      new AbortController().signal,
    )
    expect(complete).toHaveBeenCalledWith('./', '/repo')
    // The display keys off the REAL token, so rows show bare names — never a
    // `./` the user did not type.
    expect(got.candidates.map((c) => c.displayText)).toEqual(['src/', 'notes.txt'])
    expect(got.candidates[0].insertText).toBe('src/')
    expect(got.candidates[0].replacement).toEqual({ from: 3, to: 3 })
  })

  it('cd, pushd and rmdir take directories only; everything else keeps both kinds', async () => {
    const complete = vi.fn((): Promise<FsComplete> =>
      Promise.resolve({
        entries: [
          { name: 'docs', path: '/repo/docs', isDir: true },
          { name: 'notes.txt', path: '/repo/notes.txt', isDir: false },
        ],
      }),
    )
    const provider = fsProvider({ complete })
    const forCmd = async (doc: string, token: { text: string; from: number; to: number }) =>
      provider.suggest(ctx({ doc, token }), new AbortController().signal)

    const gotCd = await forCmd('cd ', { text: '', from: 3, to: 3 })
    expect(gotCd.candidates.map((c) => c.insertText)).toEqual(['docs/'])
    const gotPushd = await forCmd('pushd ', { text: '', from: 7, to: 7 })
    expect(gotPushd.candidates.map((c) => c.insertText)).toEqual(['docs/'])
    const gotRmdir = await forCmd('rmdir n', { text: 'n', from: 6, to: 7 })
    expect(gotRmdir.candidates.map((c) => c.insertText)).toEqual(['docs/'])

    // Anything else — including a command the table has never heard of —
    // keeps the documented default of "both": the rule is a promise about
    // the command's argument, and for an unknown command we promise nothing.
    const gotLs = await forCmd('ls ', { text: '', from: 3, to: 3 })
    expect(gotLs.candidates.map((c) => c.insertText)).toEqual(['docs/', 'notes.txt'])
    const gotUnknown = await forCmd('someday n', { text: 'n', from: 8, to: 9 })
    expect(gotUnknown.candidates.map((c) => c.insertText)).toEqual(['docs/', 'notes.txt'])
  })

  it('a dirs-only command whose directory holds no subdirectories names that, not "no matches"', async () => {
    // The owner's exact case: `cd Downloads/` where Downloads holds only a
    // file. The dirs-only filter removes the file, leaving zero candidates —
    // and the reason must say WHY: the directory has no subdirectories.
    const complete = vi.fn((): Promise<FsComplete> =>
      Promise.resolve({
        entries: [
          { name: 'nocx-backup.enc', path: '/repo/Downloads/nocx-backup.enc', isDir: false },
        ],
      }),
    )
    const provider = fsProvider({ complete })
    const got = await provider.suggest(
      ctx({ doc: 'cd Downloads/', token: { text: 'Downloads/', from: 3, to: 13 }, cwd: '/repo' }),
      new AbortController().signal,
    )
    expect(got.candidates).toEqual([])
    expect(got.emptyReason).toEqual({ kind: 'dirs-only-empty', dir: 'Downloads' })
  })

  it('the cwd itself is named as "this folder" when it holds no subdirectories', async () => {
    const complete = vi.fn((): Promise<FsComplete> =>
      Promise.resolve({
        entries: [{ name: 'notes.txt', path: '/repo/notes.txt', isDir: false }],
      }),
    )
    const provider = fsProvider({ complete })
    const got = await provider.suggest(
      ctx({ doc: 'cd ', token: { text: '', from: 3, to: 3 }, cwd: '/repo' }),
      new AbortController().signal,
    )
    expect(got.candidates).toEqual([])
    expect(got.emptyReason).toEqual({ kind: 'dirs-only-empty', dir: '' })
  })

  it('a non-dirs command whose directory is empty says nothing specific (generic no-match)', async () => {
    const complete = vi.fn((): Promise<FsComplete> => Promise.resolve({ entries: [] }))
    const provider = fsProvider({ complete })
    const got = await provider.suggest(
      ctx({ doc: 'ls empty/', token: { text: 'empty/', from: 3, to: 9 } }),
      new AbortController().signal,
    )
    expect(got.candidates).toEqual([])
    expect(got.emptyReason).toBeUndefined()
  })

  it('labels every row with its filesystem kind (Directory / File)', async () => {
    const got = await provider.suggest(
      ctx({ doc: 'cd ./sr', token: { text: './sr', from: 3, to: 7 } }),
      new AbortController().signal,
    )
    expect(got.candidates[0].kind).toBe('directory')
  })

  it('maps backend entries to candidates with display, match and slash-for-dirs', async () => {
    const got = await provider.suggest(
      ctx({ doc: 'cd ./sr', token: { text: './sr', from: 3, to: 7 } }),
      new AbortController().signal,
    )
    expect(complete).toHaveBeenCalledWith('./sr', '/repo')
    expect(got.candidates).toHaveLength(1)
    const c = got.candidates[0]
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
