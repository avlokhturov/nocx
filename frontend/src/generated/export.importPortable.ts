/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/export.importPortable.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the export.importPortable JSON-RPC method: what a passphrase-encrypted backup restored. Settings and private content (conversations, command history) are restored alongside the profiles and groups when the backup carries them; failures there fail the whole call, so the counts describe a complete restore.
 */
export interface ImportResult {
  /**
   * SSH connection profiles restored (created or replaced).
   */
  profilesImported: number
  /**
   * Profile groups restored (created or replaced).
   */
  groupsImported: number
}
