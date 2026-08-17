/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/ledger.bind.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the ledger.bind JSON-RPC method (nocx-rtg0.3, design §6.2) — the acknowledgement that an entry's execution was confirmed and attributed (the shell's OSC 133 C). ledger.bind repeats the immutable envelope and adds the execution facts the run row has columns for; the backend starts the run, pinning the environment observation current at that moment. A bind for an id no row carries creates the row from its envelope and binds it, for the same reason a close does (§4.3, §6.3): the envelope supplies every NOT NULL column, so a lost open never costs the entry.
 */
export interface LedgerBind {
  /**
   * The entry id the event addressed — the client-minted UUIDv7 echoed back.
   */
  id: string
  /**
   * The envelope's clientSeq, echoed — the renderer's outbox key (§6.4), never the backend's order.
   */
  clientSeq: number
  /**
   * The entry's backend-assigned ingest_seq: the ledger's only total order. Present on every ack, including one that changed nothing, because the renderer reconciles its provisional entry against it.
   */
  seq: number
  /**
   * The store's wall clock at the moment the row was created, in Unix milliseconds. Display only.
   */
  submittedAt: number
  /**
   * The entry's phase AFTER this event. bound when the bind was applied; unchanged when the outcome is replay or dropped.
   */
  phase: 'open' | 'bound' | 'closed'
  /**
   * What the event did: applied, replay (a re-delivery in the phase the row already held — §6.3 rule 4), or dropped (it would have moved the phase backwards — §6.3 rule 2; a bind that arrives after the close is exactly this, and it is logged as well as reported).
   */
  outcome: 'applied' | 'replay' | 'dropped'
}
