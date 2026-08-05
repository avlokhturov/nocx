/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/shell.footprint.status.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * The visible footprint of nocx's silent install (P10, delivery-modes design §4.1): every resolved destination with an installed fact — what was written (generation, protocol and script version), where (~/.nocx), and when nocx last SAW it. Read-only and fact-backed: this call never connects, so lastObservedAt is an observation, never a claim about what is on the host right now. removableProfileId names a saved connection that resolves to the destination and can remove it; its absence IS the explanation — the surface renders the manual-removal note from that one field and offers no button.
 */
export interface ShellFootprintStatusResult {
  /**
   * Every installed fact, ordered by identity. Empty when nothing has ever been observed installed (the surface says so rather than showing an empty shell).
   */
  destinations: {
    /**
     * The resolved destination key (user@host:port) the fact is stored under — the same key two typed lines that resolve to the same destination share.
     */
    identity: string
    /**
     * The committed generation the last accepted passport named (e.g. "v10"), preserved verbatim.
     */
    generation: string
    /**
     * The install directory on the remote host. Reported as ~/.nocx because the remote $HOME is unknowable without connecting — and it is the exact path a user removes by hand when no saved connection exists.
     */
    path: string
    /**
     * The manifest protocol version last observed, as the passport carried it.
     */
    protocolVersion: string
    /**
     * The script version last observed, as the passport carried it.
     */
    scriptVersion: string
    /**
     * When nocx last saw this bundle, from an accepted passport. An observation, never a promise about the host's current state: this call does not connect, and a host wiped since then is described as last seen, not as installed now.
     */
    lastObservedAt: string
    /**
     * The saved connection that resolves to this destination and can remove it, or null when none does. Absence is the explanation: removal needs a saved connection, and the path field is what a user removes by hand instead.
     */
    removableProfileId: string | null
  }[]
}
