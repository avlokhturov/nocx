/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/credentials.saveKeyMaterial.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the credentials.saveKeyMaterial JSON-RPC method. The single declaration of this shape: the renderer's TypeScript type is generated from it and the Go transport is validated against it.
 */
export interface SaveKeyMaterialResult {
  /**
   * SHA256 fingerprint of the stored key. Empty when the key is encrypted in a traditional PEM envelope whose public half is behind the passphrase — unknown-until-unlocked, not absent: nothing downstream may treat it as an identity.
   */
  fingerprint: string
  /**
   * True when the stored key is encrypted and no passphrase for it is stored yet. The renderer must ask for the key's passphrase then and there — a wrong one is refused against the key, a skipped one leaves the connection to ask at connect time.
   */
  passphraseWanted: boolean
}
