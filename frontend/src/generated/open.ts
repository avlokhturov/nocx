/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/open.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the open JSON-RPC method: a session is created and acknowledged (AD-7 — the server assigns the authoritative session id, so the id is minted by the backend, never the renderer). cwd is the session's starting directory, the tab's name until a program sets a title. instanceId + sessionEpoch (nocx-3oupk) name the session's incarnation: the renderer learns them here and compares every later observation of this session against them, so a record or message from a previous backend instance is told from this one. shellIntegrationReason is deliberately NOT here (nocx-dvql): it could only answer at open time, and the two integration failures that matter most arrive later — a handshake that expires ten seconds in, and a channel lost mid-session. That question is answered by the session.integrationChanged notification, as a state the backend keeps revising, and keeping a second answer in this ack is the defect AD-8 names.
 */
export interface Open {
  /**
   * Backend-assigned session id (AD-7).
   */
  sessionId: string
  /**
   * The backend instance that minted this session (AD-7 — server-authoritative, never minted by the renderer): minted once per backend start, so two instances are never equal. Together with sessionEpoch it names this session's incarnation — a restored record or a late message naming the same sessionId from another instance (or an earlier epoch of this one) is a different incarnation and must not be applied to this session.
   */
  instanceId: string
  /**
   * This session's epoch within its backend instance: minted by the backend per session, monotonic and never reused (the rule internal/lifecycle states for its own epochs, decision 8). Distinguishes a later session that reuses a sessionId from the incarnation a record names, even within one instance. Named sessionEpoch to stand apart from the lifecycle domain epoch the renderer already sees on lifecycle.changed.
   */
  sessionEpoch: number
  /**
   * Starting working directory of the session's shell, with the home directory abbreviated to ~.
   */
  cwd: string
  /**
   * The resolved destination mode for this session (nocx-mlm7): the connection-scope default the tab's capability control starts from. script (the default — N3) wraps and installs automatically, raw adds nothing, relay is consent-gated (inert until the relay lands). The mode is never proof that integration succeeded — that is what session.integrationChanged reports, and it is the only thing that reports it.
   */
  desiredMode: 'raw' | 'script' | 'relay'
}
