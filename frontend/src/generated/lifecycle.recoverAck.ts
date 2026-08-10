/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/lifecycle.recoverAck.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * The lifecycle.recoverAck JSON-RPC result: the restoration acknowledgement of ADR-0024 decision 8. The renderer calls it only after BOTH halves of the composite ack hold — it matched the shell's one-shot recovery fence in the render stream, and it applied the conventional presentation. The params are deliberately narrow: session identity and the recovery generation, and nothing else (no domain, no epoch, no attempt, no status, no prompt-readiness) — the backend acks only what it promised, and the transition permits only Lost → Native. The result is a single ok: true.
 */
export interface LifecycleRecoverAck {
  /**
   * true when the acknowledgement was accepted (the lane fell Lost → Native) or was idempotently already accepted. Rejections arrive as JSON-RPC errors: an unknown or closed session, a generation with no pending episode, or a lane that is no longer Lost.
   */
  ok: true
}
