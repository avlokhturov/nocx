/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/history.status.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the history.status JSON-RPC method, and — byte for byte the same shape — the params of the history.statusChanged notification. It is the ONE way the product says whether durable command history is actually running, and why not. Two different unavailabilities speak through it and must never grow a second vocabulary: the store never opened (no content key, an unusable budget, a failed Open — nocx-rtg0.15), and the store is open but writes are failing or the outbox overflowed at runtime (nocx-rtg0.10). It is deliberately NOT named after startup for that reason. The shape is raise/clear rather than one-shot: available=false opens a degrade episode and available=true closes it, so a notice can be raised once per episode instead of once per lost command, and the interval has a named closing event. Settings reads it so the History section never offers a toggle, a retention age and a two-number budget that govern nothing; a silent degrade the UI contradicts is how a feature that does not exist survives a release (AGENTS.md).
 */
export interface HistoryStatus {
  /**
   * True when durable command history is running: the store is open and accepting writes. False means commands are not being kept, whatever the History settings say.
   */
  available: boolean
  /**
   * Why durable history is not running — a closed machine code, so the renderer picks its own sentence rather than parsing prose. Null exactly when available is true. 'noKey' the content key could not be read; 'invalidBudget' the History size settings do not make a usable budget; 'openFailed' the history database could not be opened. A runtime write failure (nocx-rtg0.10) adds its member here rather than inventing a second status.
   */
  reason: 'noKey' | 'invalidBudget' | 'openFailed' | null
  /**
   * The underlying error in the words the backend has for it, for the second line of the notice and for a bug report. Null when available is true, and may be null even when it is false — a reason without a detail is still a complete answer.
   */
  detail: string | null
}
