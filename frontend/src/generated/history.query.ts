/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/history.query.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the history.query JSON-RPC method — the rungs of the recall ladder (design §8.10, nocx-ms7v.1). One page of past commands, newest first, already filtered to the requested scope. This is the seam between the store that owns the rows and the overlay that draws them: the overlay reads only what is declared here, and the store's schema is free to change underneath as long as this does not.
 */
export interface HistoryQuery {
  /**
   * The page, newest first. Never null: no matches is [].
   */
  entries: HistoryEntry[]
  /**
   * The rung this page was drawn from, echoed back. The caller asks for a rung and the server answers from it — it never silently widens, because a ladder whose rung you cannot see is a filter.
   */
  scope: 'directory' | 'host' | 'everywhere'
  /**
   * True when this rung has no further entries beyond this page. The overlay uses it to decide whether the next Up climbs to a wider rung rather than paging further down this one.
   */
  exhausted: boolean
  /**
   * Where the rows came from. 'session' means the in-memory ledger only — the persistent store is unavailable or empty, and the overlay must say so rather than presenting one session as all history. 'store' means the persistent store answered. Distinguishing them is the same rule as unavailable-never-collapses-into-unresolved: an empty answer and an unanswerable question must not look alike.
   */
  source: 'store' | 'session'
  /**
   * How far back the answer's source can see: the oldest retained entry's ended_at in Unix milliseconds, store-wide — independent of the rung and of the text filter, because retention is store-wide. With retention set, a search can only see part of history; the overlay renders this line so a partial answer is not presented as the whole one. Null when the source holds no completed rows (nothing to state a horizon for).
   */
  coverage: number | null
}
export interface HistoryEntry {
  /**
   * Opaque row handle. Stable for the life of the row; the address provenance recall (nocx-w7h.5) uses to ask for detail.
   */
  id: string
  /**
   * The command line that was submitted, as recorded. Secrets are masked before the row is written: the durable text is always the masked one (sk-proj-... becomes sk-p...7890), and maskedCount/maskedKinds say what was removed. Never truncated here — the overlay decides how much to show.
   */
  command: string
  /**
   * Working directory at submit time. Empty when it was never known (no OSC 7), which the overlay renders as absent rather than as the home directory.
   */
  cwd: string
  /**
   * Host at submit time, empty for the local machine. What makes the 'host' rung meaningful and what stops a remote command being replayed as if it were local.
   */
  host: string
  /**
   * How it ended. Mirrors the closed set in command-ledger.ts; 'unknown' is honest and must not be rendered as success.
   */
  status: 'running' | 'success' | 'failure' | 'interrupted' | 'unknown'
  /**
   * Process exit status, or null when it never produced one (still running, or never observed). Null is not zero.
   */
  exitCode?: number | null
  /**
   * Unix milliseconds when the command started, or null when it was never observed. The detail pane derives the duration from startedAt..endedAt; null renders as unknown, never as the epoch.
   */
  startedAt?: number | null
  /**
   * Unix milliseconds when the command finished, or null when it has not. The overlay renders the relative time from this; null renders as running, never as the epoch.
   */
  endedAt: number | null
  /**
   * How many secret-shaped regions were redacted from command before this row was written. The durable command is always the masked one; 0 means nothing was masked, and the count is always carried so a block reconstructed after a restart can say "3 secrets masked" without re-deriving the facts.
   */
  maskedCount: number
  /**
   * The kinds that were masked, deduplicated in first-occurrence order, from the closed vocabulary of internal/secrets: openai, github-pat, slack, aws-access-key, gitlab, jwt, private-key, url-userinfo, db-connstring, auth-header, env-assignment, high-entropy. Never the secret's value — kind and count are the fact, the matched text is the thing being removed. Never null: no mask is [].
   */
  maskedKinds: string[]
}
