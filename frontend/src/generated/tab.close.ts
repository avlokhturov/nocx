/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/tab.close.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * The tab.close JSON-RPC notification: the renderer telling the backend that a tab closed (nocx-tsajw). Renderer-initiated and one-way — it has no response, which is exactly where an addressing defect would hide, and why it gets the same three checks as a method. The tabId is the renderer-minted per-tab identity, the one deliberate wire exception to the rule that the renderer's session-local ids never cross (ws_history_record.go): it exists so a closed tab's pending captures die with it, and it is bound to the connection the notification arrives on, so a tab id from one connection can never reach another's captures.
 */
export interface TabClose {
  /**
   * The renderer-minted identity of the tab that closed. Opaque to the backend: minted with crypto.randomUUID() at tab creation, never reused, and the history.record calls from the same tab carry the same value so its captures are scoped to it.
   */
  tabId: string
}
