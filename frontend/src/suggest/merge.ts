// Merge rules (design §8.9.2), as invariants:
//
//  1. First results render as they arrive — the dropdown opens with the
//     first non-empty batch; a slow provider is never waited for.
//  2. A late arrival may not move the selection — the selection tracks the
//     candidate id, never the index.
//  3. The same candidate from two providers dedups by id — the later arrival
//     replaces the earlier (it carries fresher metadata).
//  4. One provider's error does not kill the others — the controller catches
//     per provider; merge itself has no error channel.
//  5. A provider may not deliver after abort — the controller aborts and
//     drops deliveries by generation, not by trusting the provider.
import type { Candidate } from './candidate'

/**
 * Merge an incoming provider batch into the accumulated list. Candidates are
 * keyed by id; a later arrival replaces an earlier one with the same id.
 */
export function mergeCandidates(existing: Candidate[], incoming: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>()
  for (const c of existing) byId.set(c.id, c)
  for (const c of incoming) byId.set(c.id, c)
  return [...byId.values()]
}

/**
 * The selected index after a merge: the previously selected candidate, found
 * by id. If it survived, its (possibly new) position is selected; if it
 * vanished, the previous index clamps into the new list. A merge never resets
 * the selection to the top — a list that shifts under the fingers is worse
 * than a slow one.
 */
export function preserveSelection(
  prev: { selectedIndex: number; candidates: Candidate[] },
  next: Candidate[],
): number {
  const id = prev.candidates[prev.selectedIndex]?.id
  if (id !== undefined) {
    const at = next.findIndex((c) => c.id === id)
    if (at >= 0) return at
  }
  if (next.length === 0) return 0
  return Math.min(prev.selectedIndex, next.length - 1)
}
