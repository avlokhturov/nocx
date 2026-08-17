/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/workspaces.create.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the workspaces.create JSON-RPC method (nocx-isoph.2, design §4.1 and §7): the stored workspace, and whether this call was a retry of one already made. The renderer ASKS for a workspace and renders what it is told — the id it minted is untrusted input, and what comes back is the row the backend actually holds, never an echo of the request. This file is also the single declaration of the workspace shape; the other workspaces.* results reference it cross-file.
 */
export interface WorkspacesCreateResult {
  workspace: Workspace
  /**
   * Whether this call found the work already done. A create whose answer was lost is retried — AD-9 exists because the socket drops — and the retry returns the FIRST object rather than minting a second one. true says so out loud, so the renderer can tell 'I made this' from 'this was already made' without comparing rows, and so the property is assertable over the wire instead of inferred from the absence of an error. A repeat asking for something DIFFERENT under the same id is not a replay: it is refused with -32602.
   */
  replayed: boolean
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
