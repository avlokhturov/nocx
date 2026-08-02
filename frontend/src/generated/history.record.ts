/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/history.record.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the history.record JSON-RPC method (nocx-rtg0.13) — the write half of the history family. The ack: the request was accepted and handed to the store. It claims nothing more — whether a row appears is decided by the live History policy (history.enabled) and is answered by history.query, never by this ack. MaskedCount and MaskedKinds report what was redacted from the command text before it was handed to the store: the durable command is always the masked one, and the block can say "3 secrets masked: openai, jwt" from this ack alone.
 */
export interface HistoryRecord {
  /**
   * How many secret-shaped regions were masked out of the command before recording. 0 when there was nothing to mask — an honest redaction that says nothing is indistinguishable from there having been nothing to redact, so the count is always carried.
   */
  maskedCount: number
  /**
   * The kinds that were masked, deduplicated in first-occurrence order, from the closed vocabulary of internal/secrets: openai, github-pat, slack, aws-access-key, gitlab, jwt, private-key, url-userinfo, db-connstring, auth-header, env-assignment, high-entropy. Never the secret's value — kind and count are the fact, the matched text is the thing being removed. Never null: no mask is [].
   */
  maskedKinds: string[]
}
