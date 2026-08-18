/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/workspaces.recolour.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the workspaces.recolour JSON-RPC method: the workspace as stored AFTER the change, read back inside the write's own transaction rather than echoed, so what the renderer draws is what the backend holds. Null clears the colour, which is an operation a person can ask for and not an omitted field — the same distinction tabs.recolour draws, and this method has the shape it has because it is the same act one rung up. A recolour never creates: an id naming no workspace is refused with -32602, because a create is the only thing that may fix an id.
 */
export interface WorkspacesRecolourResult {
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
   * The colour the user chose for it, or null for a workspace nobody coloured — the default workspace, and any row the backend minted for a session nobody recorded. One of the closed nine in the renderer's layout/workspace-colours.ts. DELIBERATELY NOT THE TAB PALETTE: a tab's colour follows the theme, because a tab decorated under one theme must still read under another; a workspace's colour is the identity of a container the user made and must NOT change when the theme does, any more than its name would. The store keeps a string and judges none of it — what is drawable is the renderer's question, and it already answers it by drawing an unknown value as no colour rather than as a broken swatch.
   */
  colour: string | null
  /**
   * Where it sits in the switcher. Written by the backend from the order workspaces.reorder was given; the renderer never computes it.
   */
  position: number
}
