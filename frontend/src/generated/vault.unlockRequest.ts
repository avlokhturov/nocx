/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/vault.unlockRequest.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Params of the vault.unlockRequest server-to-client notification. The backend requests an unlock, naming why; the renderer turns this into the unlock dialog.
 */
export interface VaultUnlockRequest {
  /**
   * Server-assigned opaque id that the vault.unlockResolved response echoes back.
   */
  requestId: string
  /**
   * Why the unlock is needed, for the dialog's context line. A human-readable sentence, never a code.
   */
  reason: string
}
