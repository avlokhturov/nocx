/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/secrets.captureSave.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the secrets.captureSave JSON-RPC method — settling a pending capture into the vault. The capture id is the idempotency key: a lost response retries with the same id and the backend answers with the recorded outcome instead of running the vault again. Saving is two stores in one order: create the vault secret (atomically name-collision-resolved — the renderer must never predict that a suffixed name is free), then rewrite the linked history rows' redaction segments to the reference. Name is the vault name ACTUALLY used.
 */
export interface SecretsCaptureSave {
  /**
   * The vault inventory name the secret was stored under — the name a {{secret:NAME}} reference would resolve by. The renderer may propose a name but never predict one: two tabs can save at once, and the vault resolves collisions and reports the real name.
   */
  name: string
  /**
   * True when the secret was created but one or more history rewrites are still owed (the brief's step-1-succeeds-step-2-fails shape). The row stays safely masked; a retry of the same capture completes the rewrites without creating a second secret.
   */
  partial?: boolean
  /**
   * The rewrite failure's message, present only when partial is true.
   */
  error?: string
}
