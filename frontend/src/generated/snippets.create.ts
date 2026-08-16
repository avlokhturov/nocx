/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/snippets.create.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the snippets.create JSON-RPC method: the created snippet, id minted by the backend.
 */
export interface SnippetsCreate {
  /**
   * Opaque, backend-minted. The renderer never constructs one.
   */
  id: string
  title: string
  /**
   * The template text with its {{ns:arg}} spans intact. Never resolved backend-side.
   */
  body: string
}
