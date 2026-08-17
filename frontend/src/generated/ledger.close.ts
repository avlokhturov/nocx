/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/ledger.close.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the ledger.close JSON-RPC method (nocx-rtg0.3, design §6.2) — the acknowledgement that an entry's outcome is known and the row is closed. ledger.close repeats the immutable envelope and adds the entry's final status, the execution's termination reason, the shell exit code, the renderer's wall clock at submit (startedAt) and its measured duration (durationMs). A close for an id no row carries CREATES the row, closed, from its envelope (§4.3, §6.3): the row needs environment_id, cwd, kind and intent, all NOT NULL, and the envelope is what supplies them — which is the whole reason the envelope repeats on every event rather than only on the first. Both paths record the SAME facts (nocx-rtg0.23): the close's terminal facts go through FinishExecution, in the run's own transaction, so a close on an already-open row stores exactly what a close that created its row does. The params are described here rather than declared: contracts/ scopes itself to result shapes, and the handler is the check for what arrives.
 */
export interface LedgerClose {
  /**
   * The entry id the event addressed — the client-minted UUIDv7 echoed back.
   */
  id: string
  /**
   * The envelope's clientSeq, echoed — the renderer's outbox key (§6.4), never the backend's order.
   */
  clientSeq: number
  /**
   * The entry's backend-assigned ingest_seq: the ledger's only total order. A close that created the row reports the sequence that creation was given.
   */
  seq: number
  /**
   * The store's wall clock at the moment the row was created, in Unix milliseconds. Display only — the command's duration is the frontend's monotonic measurement, never a difference of wall clocks.
   */
  submittedAt: number
  /**
   * The entry's phase AFTER this event. closed when the close was applied; unchanged when the outcome is replay or dropped. An entry is open from the moment its intent is accepted until exactly one of: its driver reports an outcome, its session ends, the app shuts down, or a per-kind timeout expires — no fourth exit, and every one of them writes closed (§4.3).
   */
  phase: 'open' | 'bound' | 'closed'
  /**
   * What the event did: applied, replay (a re-delivery for a row already closed — a no-op, never a second close that would rewrite a finished run's outcome), or dropped (it would have moved the phase backwards).
   */
  outcome: 'applied' | 'replay' | 'dropped'
}
