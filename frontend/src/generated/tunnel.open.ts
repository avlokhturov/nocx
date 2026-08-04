/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/tunnel.open.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the tunnel.open JSON-RPC method: the full record of the established forward. The single declaration of this shape: the renderer's TypeScript type is generated from it and the Go transport is validated against it.
 */
export interface TunnelOpenResult {
  /**
   * Backend-assigned tunnel id. The renderer echoes it to tunnel.stop; nothing else can stop a forward.
   */
  id: string
  /**
   * Forwarding strategy. Only local (-L) is implemented; remote and dynamic land into this same record.
   */
  direction: 'local' | 'remote' | 'dynamic'
  /**
   * The bind the caller asked for. Port 0 means 'allocate' — the usable address is actualBind, never this.
   */
  requestedBind: {
    /**
     * Local bind host as requested; empty on the wire means the backend default 127.0.0.1.
     */
    host: string
    /**
     * Local bind port as requested. 0 means the OS allocated an ephemeral port (see actualBind).
     */
    port: number
  }
  /**
   * The address the listener really holds. Never the requested port when the request was 0 — reporting the request would be a lie.
   */
  actualBind: {
    host: string
    /**
     * The bound port. Always the real value from the OS; nonzero once state is running.
     */
    port: number
  }
  /**
   * Remote target of the forward, host:port, as dialed over the SSH connection.
   */
  destination: string
  /**
   * Owner label the renderer attached at open (tab id or profile id). The backend tears the forward down when the tab that opened it disconnects, not by this label.
   */
  scope: string
  /**
   * Success-time bind caution, empty when none applies. Only remote (-R) forwards set it: the requested bind address is not verified — the server may have bound a different address (GatewayPorts) — so a URL built from this forward may only work on the server. Never an error: the forward is running.
   */
  caveat: string
  /**
   * Lifecycle state. open returns running (the bind happened before the result); stop returns stopped.
   */
  state: 'starting' | 'running' | 'stopped'
  /**
   * Why the forward stopped: user, connection lost, or error. Null while running.
   */
  stopReason: 'user' | 'connection lost' | 'error' | null
  /**
   * The error behind a stopped forward (bind failure, connection loss). Null while running or after a clean user stop.
   */
  error: string | null
}
