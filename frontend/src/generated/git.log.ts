/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/git.log.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the git.log JSON-RPC method: the first MaxLogEntries commits of HEAD, newest first (brief, git.log). History does not change under the user the way the working tree does, so the panel reads it when it opens, on manual refresh and after a commit — never on the poll (design D13). The log is unbounded by nature, so it is bounded by contract: completeness says which of the two answers it is — exact, more than the shown cap, or a prefix of an interrupted stream (design D9). entries is never null — an empty log arrives as [], not null.
 */
export interface GitLogResult {
  log: {
    /**
     * The first commits, newest first. Never null.
     */
    entries: LogEntry[]
    /**
     * Commits observed. Exact when completeness is complete; max+1 when capped — the extra record is how 'more than max exist' is known (design D9) — and a lower bound when cut.
     */
    total: number
    /**
     * ONE discriminator for how much of the branch's history the list holds. The panel switches on it first: a capped or cut list must not look complete (design D9).
     */
    completeness: 'complete' | 'capped' | 'cut'
  }
}
export interface LogEntry {
  /**
   * The full object id, as git prints it.
   */
  hash: string
  /**
   * git's own abbreviation of the hash.
   */
  shortHash: string
  /**
   * The first line of the commit message. May contain a tab or other whitespace — it is NUL-delimited on the wire, never line-delimited.
   */
  subject: string
  /**
   * The author's name.
   */
  authorName: string
  /**
   * The author date, RFC 3339. The panel renders the relative time from this against the wall clock.
   */
  authoredAt: string
  /**
   * The refs pointing at this commit — branch names, tags, and HEAD when the commit is HEAD — in git's own order, decoration prefixes stripped. Never null; empty when the commit carries no refs.
   */
  refs: string[]
}
