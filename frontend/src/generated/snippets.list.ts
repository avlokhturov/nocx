/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/snippets.list.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the snippets.list JSON-RPC method: the whole library, in display order. Never null — an empty library is [].
 */
export interface SnippetsList {
  snippets: Snippet[]
}
export interface Snippet {
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
