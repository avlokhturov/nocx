/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/fs.complete.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the fs.complete JSON-RPC method — local filesystem path candidates for the completion dropdown (design §8.5, nocx-w7h.3). The backend resolves the partial path (absolute, ~-based or relative to the session cwd), lists the directory it points at, and returns the entries whose name starts with the last path segment. This method is consulted ONLY by the local path provider, and the provider is inactive on a remote session — a local path must never masquerade as a remote one.
 */
export interface FsComplete {
  /**
   * The matching entries of the listed directory, sorted by name. Never null: no matches is [].
   */
  entries: FsEntry[]
}
export interface FsEntry {
  /**
   * The entry name — the last path segment, what the user sees appended to the partial path.
   */
  name: string
  /**
   * The absolute path the entry resolves to. The renderer uses it as the candidate's stable id and to show the completed path.
   */
  path: string
  /**
   * True when the entry is a directory (by directory-entry type, not by following symlinks). The renderer appends a trailing slash to directory candidates.
   */
  isDir: boolean
}
