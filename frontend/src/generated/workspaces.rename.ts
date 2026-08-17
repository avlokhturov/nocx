/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/workspaces.rename.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the workspaces.rename JSON-RPC method: the workspace as stored AFTER the rename, read back rather than echoed, so what the renderer draws is what the backend holds. A rename never creates: an id naming no workspace is refused with -32602, because a create is the only thing that may fix an id.
 */
export interface WorkspacesRenameResult {
  workspace: Workspace
}
export interface Workspace {
  /**
   * The workspace's id. Client-minted UUIDv7 and therefore UNTRUSTED INPUT (design .internal/specs/2026-08-16-tabs-panes-and-blocks-design.md §7): the shape is validated and never believed, an insert on an id that already means something else FAILS rather than overwriting, and knowing an id confers NO RIGHT to use it — a UUIDv7 embeds a timestamp and is guessable by construction, so nothing anywhere may treat possession of one as evidence.
   */
  id: string
  /**
   * The name the user gave it. A workspace, unlike a tab, is always created deliberately, so it always has one. The DEFAULT workspace is the exception that proves it: it never renders and never acquires a name (workspaces-ux §4.2), and nothing creates it through this method.
   */
  name: string
  /**
   * Where it sits in the switcher. Written by the backend from the order workspaces.reorder was given; the renderer never computes it.
   */
  position: number
}
