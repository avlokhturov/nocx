/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/snippets.delete.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the snippets.delete JSON-RPC method: the id of the deleted snippet.
 */
export interface SnippetsDelete {
  /**
   * The id of the snippet that was deleted.
   */
  id: string
}
