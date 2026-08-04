/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/tunnel.stop.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the tunnel.stop JSON-RPC method: the record of the stopped forward. Same shape as tunnel.open's result — the renderer updates the row in place with the returned state.
 */
export interface TunnelStopResult {
  /**
   * Backend-assigned tunnel id.
   */
  id: string
  /**
   * Forwarding strategy. Only local (-L) is implemented.
   */
  direction: 'local' | 'remote' | 'dynamic'
  /**
   * The bind the caller asked for at open. Port 0 means 'allocate'; the usable address is actualBind.
   */
  requestedBind: {
    host: string
    port: number
  }
  /**
   * The address the listener held while running. The OS-assigned port when the request was 0.
   */
  actualBind: {
    host: string
    port: number
  }
  /**
   * Remote target of the forward, host:port.
   */
  destination: string
  /**
   * Owner label the renderer attached at open.
   */
  scope: string
  /**
   * Success-time bind caution carried from open, empty when none applies. Only remote (-R) forwards set it: the requested bind address is not verified — the server may have bound a different address (GatewayPorts) — so a URL built from this forward may only work on the server.
   */
  caveat: string
  /**
   * Lifecycle state; always stopped for a successful stop.
   */
  state: 'starting' | 'running' | 'stopped'
  /**
   * Why the forward stopped. A user stop is 'user'; a transport death is 'connection lost'; a bind failure is 'error'.
   */
  stopReason: 'user' | 'connection lost' | 'error' | null
  /**
   * The error behind the stop, when the stop was not clean.
   */
  error: string | null
}
