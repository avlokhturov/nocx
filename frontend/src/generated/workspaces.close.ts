/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/workspaces.close.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the workspaces.close JSON-RPC method: the id of the workspace that is gone. Its tabs, and their panes, went with it — a tab has no meaning outside a workspace (ON DELETE CASCADE). The result carries the id and nothing else on purpose: there is no object left to describe, and a copy of the row as it was would be a fact about a thing that no longer exists.
 */
export interface WorkspacesCloseResult {
  /**
   * The closed workspace's id.
   */
  id: string
}
