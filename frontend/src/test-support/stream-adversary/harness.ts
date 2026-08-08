// The replay harness: takes an assembled session, replays a corpus case with
// its prelude, and snapshots the security-sensitive projections before and
// after. Infrastructure only — the corpus and the judgment are separate
// (corpus.ts, conformance.test.ts, authority-expectations.ts), so the harness
// survives the ADR-0024 renderer work unchanged.
import type { CorpusCase } from './corpus'
import type { SessionAssembly, SessionProjection } from './session'

export interface ReplayResult {
  caseId: string
  /** Deep-cloned snapshot after the prelude, before the adversarial frames. */
  before: SessionProjection
  /** Deep-cloned snapshot after the adversarial frames. */
  after: SessionProjection
  /** Frames actually dispatched through the seam (delivery proof). */
  framesDelivered: number
  /** The session's observable event log for the whole run (prelude + frames). */
  events: string[]
}

/** Assemble a fresh session, replay the prelude, snapshot, replay the frames,
 *  snapshot again. Every frame is dispatched — nothing is filtered by the
 *  harness, so a case that silently stopped reaching the session shows up as
 *  a delivery-count mismatch, not as a clean pass. */
export function replayCase(case_: CorpusCase, assemble: () => SessionAssembly): ReplayResult {
  const session = assemble()
  for (const frame of case_.prelude ?? []) {
    session.dispatch(frame)
  }
  const before = structuredClone(session.snapshot())
  for (const frame of case_.frames) {
    session.dispatch(frame)
  }
  const after = structuredClone(session.snapshot())
  return {
    caseId: case_.id,
    before,
    after,
    framesDelivered: case_.frames.length,
    events: [...session.events],
  }
}
