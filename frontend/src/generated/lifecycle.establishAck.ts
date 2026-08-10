/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/lifecycle.establishAck.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * The lifecycle.establishAck JSON-RPC result: the establishment acknowledgement of ADR-0024 decision 9. The renderer calls it after it has processed the published prompt_ready fact for the exact {lane, domain, epoch, generation} and committed the presentation that makes an editor available; the backend flushes the pending accept only on this acknowledgement — no acknowledgement, no accept, and the shell's bounded handshake wait expires with a visible native prompt (fail-open). The params are deliberately narrow: session identity, the lane/domain/epoch addressing tuple and the backend-minted generation the fact carried, and nothing else. The result is a single ok: true.
 */
export interface LifecycleEstablishAck {
  /**
   * true when the acknowledgement was accepted and the pending accept flushed. Rejections arrive as JSON-RPC errors: an unknown or closed session, a connection that is not the current subscriber, a lane of another session, a generation with no pending establishment, or a domain that is no longer established.
   */
  ok: true
}
