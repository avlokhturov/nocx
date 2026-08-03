// Ranking semantics (design §8.9.3). Features are named so they are
// testable; the golden cases in rank.test.ts pin the order as assertions.
//
// Score = position rung + quality × 1000 + path-kind rung + recency × 100
//         + frequency × 10 + environment × 5 + provider prior
//
// The rungs, in priority order:
//
//  0. The argument-position path rung — in argument position a path
//     candidate replaces one token, a history row the whole line, and the
//     token being typed is the more specific intent: path candidates outrank
//     whole-line history there, whatever history's recency claims. No other
//     rung crosses it, and it applies in NO other position.
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
  /**
   * Where the completed token sits. In argument position a path candidate
   * replaces one token while a history row replaces the whole line — the
   * token being typed is the more specific intent, so path candidates get a
   * rung above history there (the owner counted four directories in his home
   * and got none, because history buried them). Absent in callers that do
   * not know (or that rank a whole document): no rung applies.
   */
  position?: 'command' | 'argument'
}

/**
 * Argument position: a path candidate replaces one token; a history row
 * replaces the whole line. The token being typed is the more specific
 * intent, so path candidates outrank whole-line history there — no amount of
 * history recency may bury the directories under it. Sized above the entire
 * rest of the score (quality ×1000 + recency ×100 + frequency ×10 +
 * environment ×5 + prior), which holds for the shipped providers whose
 * frequency is never set.
 */
const ARGUMENT_PATH_RUNG = 100_000

/**
 * Within path candidates, a directory outranks a file — descending a tree is
 * the common motion, so a directory lands under the first Tab. This is the
 * default for every command that does not filter to directories only (the
 * dirs-only commands — cd, pushd, rmdir — filter in the provider instead):
 * we deliberately ship no per-command spec corpus (Warp carries Fig's), and
 * asking the shell is not cheap — bash has no completion specification for
 * cd (it is a builtin) and rmdir's is a function name that would have to be
 * executed to learn anything. When the completion adapter lands, the shell
 * answers and this default is deleted. Sized below the quality rung (an
 * exact file match is still the more specific intent) and above everything a
 * shipped path candidate can score (paths carry no recency or frequency;
 * environment is uniformly asserted; the fs prior is 0).
 */
const PATH_KIND_RUNG = 100

/**
 * A history row whose trailing token is a path that no longer exists ranks
 * LAST — demoted, never dropped: re-running a command to see it fail is
 * legitimate, and hiding history because the filesystem moved would be a
 * lie about what was run. Sized below every positive score (argument rung
 * 100 000 + quality 3000 + path kind 100 + recency 100 + frequency 10 +
 * environment 5 + provider prior 2), so a stale row can never outrank a
 * live one — and the list still shows it, at the bottom.
 */
const STALE_PATH_PENALTY = 1_000_000

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
    const argumentRung = ctx.position === 'argument' && c.source === 'path' ? ARGUMENT_PATH_RUNG : 0
    // A directory path candidate outranks a file one (the tree-descending
    // default for commands that do not filter). Below quality: an exact
    // file match is still the more specific intent.
    const kindRung = c.source === 'path' && c.kind === 'directory' ? PATH_KIND_RUNG : 0
    // A history row whose trailing token is a path that no longer exists
    // ranks LAST — demoted, never dropped (see STALE_PATH_PENALTY above).
    const stalePenalty = c.stalePath ? -STALE_PATH_PENALTY : 0
    const score =
      argumentRung +
      quality * 1000 +
      kindRung +
      recencyScore(c, newest, oldest) * 100 +
      (c.frequency ?? 0) * 10 +
      environmentScore(c) * 5 +
      (PROVIDER_PRIOR[c.providerId] ?? 0) +
      stalePenalty
    return { c, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.c)
}
