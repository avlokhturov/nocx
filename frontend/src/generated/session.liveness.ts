/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/session.liveness.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * The session.liveness JSON-RPC notification: what the backend currently believes about REACHING a session that has not ended (nocx-iarf9). Server-initiated and unsolicited, so it has no request to correlate against and no caller checking its shape — the same reason the exit notification gets the full three checks. UNKNOWN IS WHY THIS EXISTS: a session on a host that has stopped answering is neither alive nor dead, and both of those renderings lie — "alive" invites the user to type into nothing, "dead" throws away work that is very likely still running. The enum is deliberately the reachability half of the vocabulary only. The session record also holds dead and interrupted, and those are the exit notification's to report: exit is an EVENT (this session ended, and here is the cause — an authoritative shell exit versus a loss, nocx-ictcq) which closes or marks the tab, while this is a STATE the backend keeps revising about a session that is still there. Carrying the terminal half here as well would be two answers to one question, which is what was removed from the open ack for shellIntegrationReason (nocx-dvql). The enum is therefore exactly the set an observation may ASSERT; dead and interrupted are DERIVED from the session's own end and can be asserted by nobody. The renderer routes by sessionId (AD-7) and refuses a payload whose instanceId + sessionEpoch are not the pair its open ack carried — a notification for a previous incarnation of this id describes a different session.
 */
export interface SessionLiveness {
  /**
   * The session this belief is about (AD-7). One WebSocket carries several terminal tabs, so the renderer routes by session id before any tab may act on it.
   */
  sessionId: string
  /**
   * The backend instance that minted the session. Compared against the pair the open ack carried, so a notification out of a previous backend instance is refused rather than applied to the current tab.
   */
  instanceId: string
  /**
   * The session's epoch within that instance: which incarnation of this session id the belief is about.
   */
  sessionEpoch: number
  /**
   * alive: the session exists and nothing says otherwise. unknown: the host has stopped answering and NOTHING HAS ENDED — the channel is open and no exit was reported, so the backend knows neither that the session is running nor that it is gone, and says exactly that. The two terminal values the record can also hold (dead, interrupted) never appear here; the exit notification is their single owner.
   */
  liveness: 'alive' | 'unknown'
  /**
   * The epoch of the observation this belief came from: monotonic per session, minted when the observation was MADE rather than when it was applied. It is what lets a receiver drop a late report — an observation whose epoch is not greater than the one it last applied describes an older moment, whatever order it arrived in. Distinct from sessionEpoch, which names the incarnation rather than the observation, and from the lifecycle domain epoch on lifecycle.changed.
   */
  livenessEpoch: number
  /**
   * When the backend observed this, RFC3339 in UTC. The projection's freshness, which is a different question from its order: the epoch decides which of two observations is newer, and this says how old the belief is when it is displayed. The renderer displays it and never subtracts it.
   */
  observedAt: string
}
