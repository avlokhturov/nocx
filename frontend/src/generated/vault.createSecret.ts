/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/vault.createSecret.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the vault.createSecret JSON-RPC method. Name is the vault inventory name the secret was stored under — always carried, because a caller that asked for collision resolution (resolve: true, the prompt's ⌘S save) must build the {{secret:NAME}} reference from the vault's answer, never from the name it sent. The Secrets page ignores it.
 */
export interface VaultCreateSecret {
  /**
   * The vault inventory name the secret was stored under. Without resolve it is the requested name; with resolve it is the collision-resolved name ACTUALLY used (the vault decides openrouter.ai-2, never the renderer).
   */
  name: string
}
