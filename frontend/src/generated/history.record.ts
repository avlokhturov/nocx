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
 * Result of the history.record JSON-RPC method (nocx-rtg0.13) — the write half of the history family. The ack: the request was accepted and handed to the store. It claims nothing more — whether a row appears is decided by the live History policy (history.enabled) and is answered by history.query, never by this ack.
 */
export interface HistoryRecord {}
