/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/files.changed.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * The files.changed JSON-RPC notification: server-initiated and unsolicited, so it has no request to correlate against and no caller checking its shape — which is exactly where an addressing or shape defect would hide, and why the design gives it the same three checks as a method. It names one dirty path; the client re-lists through files.list, so exactly one code path renders a directory. It never carries entries. The destination is resolved at emit time — the binding's session's current subscriber — never stored, which is what survives an AD-9 reconnect; with no subscriber, invalidations accumulate as a set of dirty paths, emitted once on re-attach.
 */
export interface FilesChanged {
  /**
   * Which binding the change belongs to. The client maps it to its own tree generation; a binding is bounded by its session, and a viewer whose binding is gone keeps what it has on screen and issues no further calls (§5.6).
   */
  bindingId: string
  /**
   * The dirty directory path, provider syntax. Collapsing to a set of dirty paths (not a queue of events) keeps a burst that meant one change to one notification, and naturally bounds the set: a path can only be dirty if it is in the watch set.
   */
  path: string
  /**
   * The new listing digest when the backend already knew it — SFTP polling necessarily computed it, because computing it is how the change was detected at all — and absent for a local fsnotify event, where the kernel said 'something happened' and nothing has been re-listed. Optional on purpose: making it required would force the backend to list a directory in order to announce that it should be listed — the same work done twice and a race besides. When present it lets the client skip a re-list it has already applied; the client's own comparison after re-listing is what it falls back on when it is not.
   */
  rev?: string
}
