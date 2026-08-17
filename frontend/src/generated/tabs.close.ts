/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/tabs.close.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the tabs.close JSON-RPC method: the id of the tab that is gone. Its panes went with it (ON DELETE CASCADE), and any tab recording it as its LINEAGE parent keeps its row with a null parent — the honest 'provenance lost' state, never a cascade that would close a tab the user still has open.
 */
export interface TabsCloseResult {
  /**
   * The closed tab's id.
   */
  id: string
}
