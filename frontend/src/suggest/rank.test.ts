// @vitest-environment node
// Golden ranking cases (design §8.9.3). Ranking features have semantics or
// they have none: prefix quality decides first, then recency, then
// frequency, then environment match (unknown is never a wildcard), then the
// provider prior. These are assertions, not preferences — every worker
// writes the same order or the tests fail.
import { describe, it, expect } from 'vitest'
import { rankCandidates } from './rank'
import type { Candidate } from './candidate'

const NOW = 1_750_000_000_000

const base = (over: Partial<Candidate>): Candidate => ({
  id: 'c',
  targetId: 'shell',
  providerId: 'command',
  displayText: 'x',
  insertText: 'x',
  replacement: { from: 0, to: 1 },
  matchRanges: [{ from: 0, to: 1 }],
  source: 'command',
  eligibleForGhostText: true,
  ...over,
})

const ids = (cs: Candidate[]): string[] => cs.map((c) => c.id)

describe('rankCandidates', () => {
  it('prefix quality dominates: exact match beats a plain prefix', () => {
    const ranked = rankCandidates(
      [base({ id: 'prefix', insertText: 'gitk' }), base({ id: 'exact', insertText: 'git' })],
      { query: 'git', now: NOW },
    )
    expect(ids(ranked)).toEqual(['exact', 'prefix'])
  })

  it('given identical quality, the more recent ranks first (the §8.4 assertion)', () => {
    const ranked = rankCandidates(
      [
        base({
          id: 'old',
          providerId: 'history',
          insertText: 'git status',
          freshness: NOW - 100_000,
        }),
        base({
          id: 'fresh',
          providerId: 'history',
          insertText: 'git status',
          freshness: NOW - 1_000,
        }),
      ],
      { query: 'git', now: NOW },
    )
    expect(ids(ranked)).toEqual(['fresh', 'old'])
  })

  it('a candidate without recency ranks below a recent one, above nothing else changes', () => {
    const ranked = rankCandidates(
      [
        base({ id: 'cmd', insertText: 'gittool' }),
        base({
          id: 'hist',
          providerId: 'history',
          insertText: 'git status',
          freshness: NOW - 60_000,
        }),
      ],
      { query: 'git', now: NOW },
    )
    expect(ids(ranked)).toEqual(['hist', 'cmd'])
  })

  it('frequency breaks the tie when recency is equal', () => {
    const ranked = rankCandidates(
      [
        base({
          id: 'rare',
          providerId: 'history',
          insertText: 'git x',
          freshness: NOW - 5_000,
          frequency: 1,
        }),
        base({
          id: 'common',
          providerId: 'history',
          insertText: 'git x',
          freshness: NOW - 5_000,
          frequency: 9,
        }),
      ],
      { query: 'git', now: NOW },
    )
    expect(ids(ranked)).toEqual(['common', 'rare'])
  })

  it('a stale-path history row ranks last — demoted below every live row, never dropped', () => {
    // The reported case: the file the row names is gone. The stale row must
    // sink below a FRESH row of the same line, below a plain history row,
    // and below a path candidate — but still be present (re-running a
    // command to see it fail is legitimate).
    const ranked = rankCandidates(
      [
        base({
          id: 'stale-fresh',
          providerId: 'history',
          source: 'history',
          insertText: 'rm zzz-e2e-cmp-msbojbc7',
          freshness: NOW - 1_000,
          stalePath: true,
        }),
        base({
          id: 'stale-old',
          providerId: 'history',
          source: 'history',
          insertText: 'rm zzz-e2e-cmp-msbojbc7',
          freshness: NOW - 100_000,
          stalePath: true,
        }),
        base({
          id: 'live-hist',
          providerId: 'history',
          source: 'history',
          insertText: 'rm other-file',
          freshness: NOW - 10_000,
        }),
        base({
          id: 'path',
          providerId: 'fs',
          source: 'path',
          kind: 'directory',
          insertText: 'zzz/',
        }),
      ],
      { query: 'rm zzz', now: NOW, position: 'argument' },
    )
    expect(ids(ranked)).toEqual(['path', 'live-hist', 'stale-fresh', 'stale-old'])
  })

  it('environment match: an unknown facet is never a wildcard', () => {
    const ranked = rankCandidates(
      [
        base({
          id: 'unknown-env',
          providerId: 'history',
          insertText: 'git status',
          freshness: NOW - 5_000,
          environment: { confidence: 'unknown' },
        }),
        base({
          id: 'asserted-env',
          providerId: 'history',
          insertText: 'git status',
          freshness: NOW - 5_000,
          environment: { cwd: '/repo', confidence: 'asserted' },
        }),
      ],
      { query: 'git', now: NOW },
    )
    // Identical quality, recency and frequency: the asserted environment must
    // win — an unknown facet must never be treated as a match.
    expect(ids(ranked)).toEqual(['asserted-env', 'unknown-env'])
  })

  it('provider prior is the last tiebreak', () => {
    const ranked = rankCandidates(
      [
        base({ id: 'path', providerId: 'fs', insertText: 'git-tools', source: 'path' }),
        base({ id: 'cmd', insertText: 'git-tools' }),
      ],
      { query: 'git', now: NOW },
    )
    expect(ids(ranked)).toEqual(['cmd', 'path'])
  })

  it('argument position: path candidates outrank whole-line history, whatever its recency', () => {
    const ranked = rankCandidates(
      [
        base({
          id: 'hist',
          providerId: 'history',
          source: 'history',
          insertText: 'cd projects',
          freshness: NOW - 1, // as fresh as history gets
        }),
        base({
          id: 'path',
          providerId: 'fs',
          source: 'path',
          insertText: 'projects/',
        }),
      ],
      { query: 'cd ', now: NOW, position: 'argument' },
    )
    // A path candidate replaces one token; a history row replaces the whole
    // line. The token being typed is the more specific intent, so the path
    // wins even though history is fresher — the §8.4 recency assertion does
    // not cross this rung.
    expect(ids(ranked)).toEqual(['path', 'hist'])
  })

  it('the argument rung applies only in argument position — command position keeps the provider prior', () => {
    const ranked = rankCandidates(
      [
        base({
          id: 'hist',
          providerId: 'history',
          source: 'history',
          insertText: 'git status',
          freshness: NOW - 1,
        }),
        base({
          id: 'path',
          providerId: 'fs',
          source: 'path',
          insertText: 'git-tools/',
        }),
      ],
      { query: 'git', now: NOW, position: 'command' },
    )
    expect(ids(ranked)).toEqual(['hist', 'path'])
  })

  it('within path candidates, a directory outranks a file (the tree-descending default)', () => {
    const ranked = rankCandidates(
      [
        base({
          id: 'file',
          providerId: 'fs',
          source: 'path',
          kind: 'file',
          insertText: 'beta',
        }),
        base({
          id: 'dir',
          providerId: 'fs',
          source: 'path',
          kind: 'directory',
          insertText: 'alpha/',
        }),
      ],
      { query: 'a', now: NOW, position: 'argument' },
    )
    expect(ids(ranked)).toEqual(['dir', 'file'])
  })

  it('the path-kind rung yields to an exact file match (quality is the correctness rung)', () => {
    const ranked = rankCandidates(
      [
        base({
          id: 'exact-file',
          providerId: 'fs',
          source: 'path',
          kind: 'file',
          insertText: 'alpha',
        }),
        base({
          id: 'dir',
          providerId: 'fs',
          source: 'path',
          kind: 'directory',
          insertText: 'alphax/',
        }),
      ],
      { query: 'alpha', now: NOW, position: 'argument' },
    )
    expect(ids(ranked)).toEqual(['exact-file', 'dir'])
  })

  it('identical scores keep arrival order (stable)', () => {
    const ranked = rankCandidates(
      [base({ id: 'first', insertText: 'gitx' }), base({ id: 'second', insertText: 'gity' })],
      { query: 'git', now: NOW },
    )
    expect(ids(ranked)).toEqual(['first', 'second'])
  })

  it('an empty query ranks everything as a plain prefix', () => {
    const ranked = rankCandidates(
      [base({ id: 'a', insertText: 'ab' }), base({ id: 'b', insertText: 'aa' })],
      { query: '', now: NOW },
    )
    // No exact match for ''; everything is a prefix; ties stay stable.
    expect(ids(ranked)).toEqual(['a', 'b'])
  })

  it('does not reorder across quality rungs', () => {
    const ranked = rankCandidates(
      [
        base({ id: 'old-exact', insertText: 'git', freshness: NOW - 10 ** 9 }),
        base({
          id: 'fresh-prefix',
          providerId: 'history',
          insertText: 'git status',
          freshness: NOW - 1,
        }),
      ],
      { query: 'git', now: NOW },
    )
    // Even a very old exact match beats a very fresh prefix: quality is the
    // correctness rung, and the "exact rung" must not be a lie.
    expect(ids(ranked)).toEqual(['old-exact', 'fresh-prefix'])
  })
})
