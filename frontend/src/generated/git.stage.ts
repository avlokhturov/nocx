/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/git.stage.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the git.stage JSON-RPC method: the fresh post-mutation status (design D12 — a mutation returns the fresh status, and D17's response-scope discipline is what makes that stick). paths[] never means 'all': an empty array is a no-op that still returns the current status, and 'all' is git.stageAll (D19). A staging failure is a JSON-RPC error — the panel repaints from its next poll — because there is no renderable refusal state for staging; git.unstage is the one operation with one (the unborn branch).
 */
export interface GitStageResult {
  status: Status
}
export interface Status {
  /**
   * The current branch name; empty when the HEAD is detached, in which case detached is true.
   */
  branch: string
  /**
   * True when HEAD is detached (porcelain v2's branch.head is '(detached)').
   */
  detached: boolean
  /**
   * True when the branch is unborn (porcelain v2's branch.oid is '(initial)'): no commits exist yet, HEAD cannot be resolved, and individual unstaging is impossible (design D19 — unstage-ALL is the operation that works there).
   */
  unborn: boolean
  /**
   * Short hash of HEAD; empty when the branch is unborn.
   */
  head: string
  /**
   * The branch's upstream, in the form git itself prints (e.g. 'origin/main'); empty when the branch has none.
   */
  upstream: string
  /**
   * Commits ahead of the upstream; 0 when there is no upstream.
   */
  ahead: number
  /**
   * Commits behind the upstream; 0 when there is no upstream.
   */
  behind: number
  /**
   * Index-side changes: one entry per file whose index column is not clean. Never null.
   */
  staged: Entry[]
  /**
   * Worktree-side changes: one entry per file whose worktree column is not clean, including untracked files (X='?', Y='?'). Never null.
   */
  unstaged: Entry[]
  /**
   * Files with an unresolved conflict (the porcelain v2 'u' records). These are never stageable from the panel and never land in staged or unstaged (design: merge conflicts as a surface, out of scope). Never null.
   */
  conflicted: Entry[]
  /**
   * Number of status records observed. Its meaning is fixed by completeness: exact when complete or capped, a lower bound when cut (design D9).
   */
  total: number
  /**
   * ONE discriminator for how much of the repository's status the lists hold. The panel switches on it first: a traversal stopped by the work ceiling after 100 records must not look complete (design D9).
   */
  completeness: 'complete' | 'capped' | 'cut'
}
export interface Entry {
  /**
   * The file path, repository-relative, in git's own spelling.
   */
  path: string
  /**
   * The porcelain v2 index-side status column ('A', 'M', 'D', 'R', 'C', 'U', '?', ...). A file can be in both lists — X and Y both non-'.' — which is why a row's key is {side, path}, not path.
   */
  x: string
  /**
   * The porcelain v2 worktree-side status column ('.' when that side is clean, '?' for an untracked file, 'U' for a conflicted one).
   */
  y: string
}
