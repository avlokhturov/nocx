/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/notes.create.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the notes.create JSON-RPC method: the created note. The backend mints the id and both timestamps.
 */
export interface NotesCreate {
  /**
   * Opaque, backend-minted.
   */
  id: string
  /**
   * The note, markdown, exactly as it was written.
   */
  body: string
  /**
   * Epoch milliseconds. An edit never moves it.
   */
  createdAt: number
  /**
   * Epoch milliseconds of the last edit.
   */
  updatedAt: number
  /**
   * DERIVED from the body's first non-empty line, every time it is read — never stored (design §7). Empty when the body has nothing to name it by; the surface names that one with its creation date, which needs a locale the backend does not have. It travels with the note so the tab's title has ONE owner: a renderer deriving its own would be the second.
   */
  title: string
}
