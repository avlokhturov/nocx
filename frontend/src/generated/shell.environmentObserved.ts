/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/shell.environmentObserved.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * The renderer's report of what a minted attempt produced, crossing the control plane as a typed observation (2026-08-05 delivery-modes design §5.4 — the AD-1 amendment that admits it is named in the P7 commit). The renderer sends an accepted readiness passport (the tracker accepted it, so its id is the id nocx minted for the attempt in flight), or a null passport when the attempt ended with none. Only an attempt the backend minted can change state; the first observation per attempt decides it.
 */
export interface ShellEnvironmentObservedResult {
  /**
   * Whether the environmentId matched a live minted attempt. false means the report is stale or foreign (typically after a backend restart) — the renderer logs it and nothing is written.
   */
  processed: boolean
  /**
   * Whether the durable installed-fact store changed: an accepted passport recorded the installation, or a no-passport report invalidated a fact that had expected installed-script. false for a processed report that wrote nothing (e.g. a duplicate, or a bootstrap attempt ending without a passport).
   */
  factUpdated: boolean
}
