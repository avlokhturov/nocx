/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/export.import.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the export.import JSON-RPC method: what a configuration export restored. Settings are restored alongside the profiles and groups but are not counted here — their presence is not the interesting number, and a half-restored settings document is an error, not a count.
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
