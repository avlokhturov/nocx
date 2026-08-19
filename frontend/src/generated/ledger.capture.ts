/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/ledger.capture.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the ledger.capture JSON-RPC method (nocx-2f0f, design §4) — the acknowledgement that one body of a frozen block was accepted. A capture is idempotent on (artifactId, seq): the renderer mints the artifact id, so a retry after a lost ack returns the same answer and writes nothing. The params are described in the handler rather than declared here — contracts/ scopes itself to result shapes.
 */
export interface LedgerCapture {
  /**
   * The artifact the chunk landed in: the id the caller minted, echoed back so a caller that lost track of its own request still knows what to send the next chunk under.
   */
  artifactId: string
  /**
   * Whether the body is retained. FALSE IS NOT A FAILURE and must not be reported as one: output retention is off, or the entry is marked sensitive, and the block keeps its row while keeping no body. The renderer stops sending the remaining chunks when it sees this rather than pushing a body nobody will store.
   */
  stored: boolean
}
