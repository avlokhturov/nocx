/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/ledger.open.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the ledger.open JSON-RPC method (nocx-rtg0.3, design §6.2) — the acknowledgement that an intent was accepted into the one authoritative ledger. ledger.open carries the immutable envelope (id, sessionId, cwd, kind, intent, sensitivity, clientSeq) and creates the entry open/pending; the facts it carries are derived by the renderer from OSC 133 markers it already owns, never inferred by the backend (AD-1 as amended by nocx-m64b, AD-6 unchanged). The three lifecycle acks share one shape on purpose: the renderer's outbox drains events of three kinds through one path, and an ack it has to switch on would be a second ordering implementation.
 */
export interface LedgerOpen {
  /**
   * The entry id the event addressed — the client-minted UUIDv7 echoed back. It is an UNTRUSTED idempotency key: the store binds it to the client identity and a digest of the submitted content, so a replay of the same id with different content is refused rather than aliasing a second intent.
   */
  id: string
  /**
   * The envelope's clientSeq, echoed. It is the RENDERER's ordering key for its outbox (§6.4) and is never the backend's order; it rides the ack so the outbox knows which unacknowledged event was acknowledged.
   */
  clientSeq: number
  /**
   * The backend-assigned ingest_seq: the ledger's ONLY total order (ADR-0019 §2 — commit order, not causality). Wall-clock milliseconds are not a key, because two windows submit in the same millisecond, and the client-minted id is identity rather than authority.
   */
  seq: number
  /**
   * The store's wall clock at the moment the row was created, in Unix milliseconds. Display only — durations come from the frontend's monotonic clock, and ordering comes from seq.
   */
  submittedAt: number
  /**
   * The entry's phase AFTER this event: open (intent accepted, execution unconfirmed), bound (execution confirmed and attributed) or closed (outcome known). Unchanged when the outcome is replay or dropped.
   */
  phase: 'open' | 'bound' | 'closed'
  /**
   * What the event did. applied — the row was created or moved forwards. replay — a re-delivery for a row already in that phase, a no-op (§6.3 rule 4). dropped — the event would have moved the phase backwards and was discarded and logged (§6.3 rule 2). The outcome is on the wire and not only in a log, because an event the product discarded is a fact the renderer's outbox must be able to act on.
   */
  outcome: 'applied' | 'replay' | 'dropped'
}
