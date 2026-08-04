/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/ports.pause.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the ports.pause JSON-RPC method: an empty acknowledgement. The method's only observable effect is the scheduler's paused flag, which the next ports.status carries.
 */
export interface PortsPauseResult {}
