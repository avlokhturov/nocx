/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/agent.status.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the agent.status JSON-RPC method (design §7): endpoint configured, credential resolvable, last probe result. The ask surface reads it before offering an ask; a soft degrade — no endpoint, an unresolvable credential, a failed probe — is visible in the product, never only in a log. The probe result shape is declared ONCE, in endpoints.probe.schema.json, and referenced here cross-file.
 */
export interface AgentStatusResult {
  /**
   * At least one AI endpoint is stored (design §7: 'endpoint configured').
   */
  endpointConfigured: boolean
  /**
   * At least one stored endpoint has a credential the vault can currently resolve — the vault is unsealed and the secret exists. A sealed vault answers false, and the ask surface can offer the unlock prompt.
   */
  credentialResolvable: boolean
  /**
   * The last endpoints.probe outcome, or null when none has run in this process lifetime. Process-lifetime by design: a probe's meaning expires with the endpoint that produced it.
   */
  lastProbe: EndpointsProbeResult | null
}
/**
 * Result of the endpoints.probe JSON-RPC method — the Test button's whole meaning: it probes what will actually be used, a real streaming completion through the same engine the ask transaction will use, not one cheap completion (design §4.5, bead notes). The params are the form's DRAFT values (name, baseUrl, key, model) — the endpoint may not be saved yet, and the key is an input that never crosses back (ADR-0030). This schema is the SINGLE declaration of the probe result shape: agent.status's lastProbe references this whole file cross-file.
 */
export interface EndpointsProbeResult {
  /**
   * The probed draft's display name. Historical fact: agent.status reports the last probe whatever the endpoint list says now.
   */
  name: string
  /**
   * The model id that was probed — the form tests its first model.
   */
  model: string
  /**
   * True when the probe streamed at least one content chunk — the endpoint answered with an answer.
   */
  ok: boolean
  /**
   * What went wrong when ok is false: the dial failure, the HTTP status, the refused stream, zero content. Absent when ok.
   */
  error?: string
  /**
   * Total wall time of the probe, dial to end of stream.
   */
  elapsedMs: number
  /**
   * When the probe finished, wall-clock (RFC 3339).
   */
  at: string
}
