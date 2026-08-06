/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/git.unstage.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the git.unstage JSON-RPC method. This is the one mutation whose failure is a RESULT state rather than a transport error: individual unstaging on an unborn branch fails with git's own error (git reset with pathspecs resolves HEAD, which an unborn branch lacks — design D19 guarantees only unstage-ALL there, bare git reset). The panel must not offer per-file unstage on an unborn branch, and when the call is made anyway the failure must arrive as something it can render, not as an error that looks like a bug. The discriminator is the branch's unbornness re-read from the repository — never parsed from git's prose (D11). Both branches carry the fresh status so the panel repaints from reality.
 */
export interface GitUnstageResult {
  /**
   * ok — the unstage (or the empty-paths no-op) succeeded and status is the fresh post-mutation status. unborn — the branch is unborn, per-file unstaging is impossible there, and status is a fresh read so the panel can repaint and stop offering the control.
   */
  state: 'ok' | 'unborn'
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
