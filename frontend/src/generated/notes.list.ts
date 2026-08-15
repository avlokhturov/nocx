/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/notes.list.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the notes.list JSON-RPC method: every note as a row, newest first. A row carries a title and an excerpt and NEVER the body — the list is a list. Never null: an empty library is [].
 */
export interface NotesList {
  notes: NoteRow[]
}
export interface NoteRow {
  /**
   * Opaque, backend-minted. The renderer never constructs one.
   */
  id: string
  /**
   * DERIVED from the body's first non-empty line, every time it is read — never stored (design §7). Empty when the body has nothing to name it by; the surface names that one with its creation date, which needs a locale the backend does not have.
   */
  title: string
  /**
   * One line of the body for the row's second line, bounded. On a search hit it carries the words that matched, so a row can explain why it is there.
   */
  excerpt: string
  /**
   * Epoch milliseconds of the last edit.
   */
  updatedAt: number
}
