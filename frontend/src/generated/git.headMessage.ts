/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/git.headMessage.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the git.headMessage JSON-RPC method: the Amend prefill, fetched once when the checkbox is ticked. An unborn branch has no HEAD message to amend — that is the none state, not an error; an invocation that cannot be made is the error.
 */
export interface GitHeadMessageResult {
  /**
   * ok — HEAD has a message and message carries it. none — the branch is unborn; there is nothing to amend.
   */
  state: 'ok' | 'none'
  /**
   * The full HEAD message (subject and body). Present exactly when state is ok.
   */
  message?: string
}
