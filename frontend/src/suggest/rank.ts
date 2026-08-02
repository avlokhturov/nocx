// Ranking semantics (design §8.9.3). Features are named so they are
// testable; the golden cases in rank.test.ts pin the order as assertions.
//
// Score = quality × 1000 + recency × 100 + frequency × 10 + environment × 5
//         + provider prior
//
// The rungs, in priority order:
//
//  1. Prefix quality — exact match beats a plain prefix, and quality is an
//     absolute rung: no amount of recency promotes a plain prefix above an
//     exact match. The "exact rung" must never be a lie.
//  2. Recency — given two candidates identical but for recency, the more
//     recent ranks first (§8.4's assertion). Normalised within the set: the
//     newest candidate scores 1, the oldest 0. Candidates without a
//     timestamp (command names, paths) score 0 — they claim no recency.
//  3. Frequency — how often the underlying record has been seen; the slot
//     exists for a provider that can observe counts (ours cannot, today).
//  4. Environment match — a candidate that CLAIMS its environment with
//     asserted confidence outranks one claiming unknown confidence: an
//     unknown facet is never a wildcard. A candidate carrying no environment
//     evidence at all scores full marks, because its provider vouches for
//     applicability by construction (§8.5).
//  5. Provider prior — the last tiebreak, tuned per provider: the command
//     store is the shell's own answer and wins ties; the user's history is
//     next; a filesystem path is last.
import type { Candidate } from './candidate'

export interface RankContext {
  /** The text being completed (the token or the line). */
  query: string
  /** Wall-clock epoch milliseconds for recency normalisation. */
  now: number
}

const QUALITY_EXACT = 3
const QUALITY_PREFIX = 1

/** 0..1, newest candidate in the set = 1, oldest = 0. A single timed
 *  candidate is both newest and oldest and scores 1: it claims recency and
 *  the rest of the set claims none. No timed candidate at all → everyone 0. */
function recencyScore(c: Candidate, newest: number, oldest: number): number {
  if (c.freshness === undefined || oldest === 0) return 0
  if (newest === oldest) return 1
  return (c.freshness - oldest) / (newest - oldest)
}

/** 0..1: asserted > derived > unknown; absent = 1 (the provider vouches). */
function environmentScore(c: Candidate): number {
  const env = c.environment
  if (!env) return 1
  switch (env.confidence) {
    case 'asserted':
      return 1
    case 'derived':
      return 0.5
    case 'unknown':
      return 0
  }
}

const PROVIDER_PRIOR: Record<string, number> = { command: 2, history: 1, fs: 0 }

/**
 * Rank candidates in place of the dropdown order. Stable: candidates with
 * identical scores keep their arrival order.
 */
export function rankCandidates(candidates: Candidate[], ctx: RankContext): Candidate[] {
  if (candidates.length === 0) return []

  let newest = 0
  let oldest = Infinity
  for (const c of candidates) {
    if (c.freshness === undefined) continue
    if (c.freshness > newest) newest = c.freshness
    if (c.freshness < oldest) oldest = c.freshness
  }
  if (oldest === Infinity) oldest = 0

  const scored = candidates.map((c) => {
    const exact = c.insertText === ctx.query
    const quality = exact ? QUALITY_EXACT : QUALITY_PREFIX
    const score =
      quality * 1000 +
      recencyScore(c, newest, oldest) * 100 +
      (c.frequency ?? 0) * 10 +
      environmentScore(c) * 5 +
      (PROVIDER_PRIOR[c.providerId] ?? 0)
    return { c, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.c)
}
