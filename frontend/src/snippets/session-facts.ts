// The live facts an `env:` key may read — the asynchronous half of the
// resolver. resolve.ts stays synchronous: it takes SessionFacts as an
// argument. THIS module answers the facts, and it is asynchronous because
// the branch comes from git.status, a wire call scoped to a binding (AD-9)
// — no synchronous bag can hold it. A fact that cannot be answered right
// now is null, never '' — `cd {{env:cwd}}` becoming `cd` is the failure
// this rule exists for (design §7.4, §11.2).
import type { GitStatusResult } from '../generated/git.status'

export interface SessionFacts {
  cwd: string | null
  host: string | null
  user: string | null
  branch: string | null
}

export interface SessionFactsProvider {
  /** Read the ACTIVE pane. Asynchronous because the branch is a wire call.
   *  A fact that cannot be answered is null — never ''. */
  facts(): Promise<SessionFacts>
}

/** The active pane's contribution to one fire — the composition root's
 *  RESOLVED identity for the pane, never the raw domain-environment view:
 *  the root answers host and user for a local shell (the machine's name,
 *  the session's user) or null when it cannot. The view's fields use '' as
 *  their unknown marker (a local shell has no host, a fresh domain has no
 *  cwd); the provider maps that marker to null HERE, at the last boundary
 *  before a substitution. Tests fake this seam. */
export interface SnippetPaneSource {
  paneFacts(): {
    cwd: string | null
    host: string | null
    user: string | null
    /** The backend-issued git binding for the pane's session, or null when
     *  the session has none (not open, or no repository established). The
     *  provider never invents an id to ask with. */
    gitBindingId: string | null
  } | null
}

/** The git seam — exactly the status call, nothing else. */
export interface SnippetGitStatus {
  status(bindingId: string): Promise<GitStatusResult>
}

export function createSessionFactsProvider(
  pane: SnippetPaneSource,
  git: SnippetGitStatus,
): SessionFactsProvider {
  return {
    async facts(): Promise<SessionFacts> {
      const p = pane.paneFacts()
      if (p === null) return { cwd: null, host: null, user: null, branch: null }
      let branch: string | null = null
      if (p.gitBindingId !== null) {
        try {
          branch = (await git.status(p.gitBindingId)).status.branch || null
        } catch {
          // Unavailable is null, never a thrown fire: the caller refuses the
          // whole fire naming the key (design §11.2). A detached HEAD's ''
          // is the same answer — there is no branch to name.
          branch = null
        }
      }
      // The view marks unknown as '' (the domain environment's empty-on-
      // local rule); the resolver requires null. THIS is the boundary where
      // one becomes the other — a '' reaching a substitution is
      // `cd {{env:cwd}}` becoming `cd`.
      return { cwd: p.cwd || null, host: p.host || null, user: p.user || null, branch }
    },
  }
}
