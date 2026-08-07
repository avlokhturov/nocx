/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/git.diff.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the git.diff JSON-RPC method: the unified diff of one file on one side, as git computed it (design D10 — git computes the diff, the frontend renders text; a second diff algorithm in the browser would disagree with git exactly where nobody looks). state is the discriminator: a row can be clicked in the same second an agent reverts the file, so empty and gone are states, not errors. The shape is deliberately extensible: a later split view adds oldText/newText as new optional fields, so the schema grows by addition (design §5.3).
 */
export interface GitDiffResult {
  /**
   * The diff outcome. tooLarge is the only state the backend's byte-bound cut maps to (the cut itself stays private to the local implementation); text is then a prefix and says so through truncated.
   */
  state: 'ok' | 'binary' | 'tooLarge' | 'empty' | 'gone'
  /**
   * The unified diff text. Empty for binary (git said 'Binary files differ'; there is nothing to render) and for empty/gone. A prefix of the full diff when tooLarge.
   */
  text: string
  /**
   * True exactly when state is tooLarge: the byte bound was reached and text is a prefix. A silently clipped diff is a worse lie than one that admits it.
   */
  truncated: boolean
}
