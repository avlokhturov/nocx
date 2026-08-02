/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/secrets.captureDismiss.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the secrets.captureDismiss JSON-RPC method — destroying a pending capture and suppressing its fingerprint for the rest of the application session (never forever: durably tracking a negative decision about a secret the user declined to store would outlive the context the decision was made in). Idempotent: a second dismiss of the same capture is a no-op.
 */
export interface SecretsCaptureDismiss {}
