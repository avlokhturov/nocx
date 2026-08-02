// The Candidate contract (design §8.9.1) — one row of the completion
// dropdown. The shape is deliberate: `displayText` and `insertText` are
// separate fields because the evidence column is displayed and must never be
// inserted; `replacement` exists because ghost text needs to know where a
// candidate goes; `eligibleForGhostText` exists because sensitivity is
// expressed in the type — a rule the type cannot state is a rule the next
// provider breaks.

/** Which kind of surface produced the candidate. */
export type CandidateSource = 'command' | 'history' | 'path'

/** Which rung of the recall ladder (§10.6) the candidate came from. */
export type CandidateScope = 'directory' | 'host' | 'everywhere'

/**
 * Outcome evidence (§8.10's evidence column): how the underlying command
 * ended, when the provider can know. Never invented — a history entry that
 * has no recorded outcome carries no `outcome` at all.
 */
export interface OutcomeEvidence {
  status: 'success' | 'failure' | 'interrupted' | 'unknown'
  exitCode?: number
}
export interface EnvironmentEvidence {
  cwd?: string
  host?: string
  confidence: 'asserted' | 'derived' | 'unknown'
}

/** A half-open offset range into a document. */
export interface CandidateRange {
  from: number
  to: number
}

export interface Candidate {
  /** Stable — dedup across providers depends on it. */
  readonly id: string
  readonly targetId: string
  readonly providerId: string
  /** What is shown. */
  readonly displayText: string
  /** What is inserted — deliberately not the same field. */
  readonly insertText: string
  /** Where it goes; ghost text needs this. */
  readonly replacement: CandidateRange
  /** Why it matched, for highlighting — offsets into displayText. */
  readonly matchRanges: CandidateRange[]
  readonly source: CandidateSource
  /** Which rung of §10.6 this came from. */
  scope?: CandidateScope
  /**
   * How often the underlying record has been seen (the ranking feature's
   * data). Absent when the provider cannot observe counts — our shipped
   * providers cannot, so this stays unset today and the slot exists for the
   * provider that can (design §8.9.3).
   */
  frequency?: number
  /**
   * Wall-clock epoch milliseconds of the underlying record (the same clock
   * the ledger stamps and the store persists). Absent for candidates with no
   * recency to claim — a command name has no timestamp.
   */
  freshness?: number
  outcome?: OutcomeEvidence
  environment?: EnvironmentEvidence
  /** Sensitivity, expressed in the type: false candidates never become ghost
   *  text and never accept via Right/End (design §8.7, §9). */
  readonly eligibleForGhostText: boolean
}
