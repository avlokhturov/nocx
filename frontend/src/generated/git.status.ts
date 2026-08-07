/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/git.status.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the git.status JSON-RPC method: what changed in the bound repository, from one git status --porcelain=v2 -z --branch --untracked-files=all invocation (design D7). This file is also the single declaration of the shared status shape: the six other results that carry a status (git.open, git.stage, git.unstage, git.stageAll, git.unstageAll, git.commit) reference $defs.status here rather than declaring it again, so one concept has one owner (AD-8). The lists are never null — an empty set arrives as [], not null; that exact bug was found by the first contract schema this repository ever ran.
 */
export interface GitStatusResult {
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
   * ONE discriminator for how much of the repository's status the lists hold. The panel switches on it first: a traversal stopped by the work ceiling after 100 records must not look complete (design D9). 'cut' also covers a count read that was stopped or failed: the lists are then complete and total exact, but no entry carries counts — counts are all-or-nothing, because a partial count set makes rows past the cut look like rows with nothing to count (brief nocx-i4ki).
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
  /**
   * Lines added to this file on this side, from git diff --numstat. Absent means no count exists — the file is untracked or binary, the entry is conflicted, or the count read was bounded out (design D9, brief nocx-i4ki). Absent is NOT zero: a real 0/0 answer (a pure rename, an empty file) arrives as 0.
   */
  added?: number
  /**
   * Lines deleted from this file on this side, from git diff --numstat. Absent means no count exists, exactly as for added.
   */
  deleted?: number
}
