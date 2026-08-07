/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/git.remote.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the git.remote JSON-RPC method: the URL of the remote the current branch tracks (brief, nocx-hc0m), derived by git — symbolic-ref names the branch, the upstream atom names the remote, remote get-url reads the URL. none is the ordinary answer, never an error: detached HEAD, no upstream, a deleted remote, a local-path remote — the panel draws no link for it (design D14). The wire carries the RAW remote URL; the conversion to a host's web page is the renderer's, in one module with its own tests, because the branch URL and commit URL differ per host and an unknown host must produce no link rather than a guessed one.
 */
export interface GitRemoteResult {
  /**
   * ok — the branch tracks a remote and url carries its fetch URL. none — nothing to open.
   */
  state: 'ok' | 'none'
  /**
   * The remote's fetch URL exactly as git reported it. Present exactly when state is ok.
   */
  url?: string
}
