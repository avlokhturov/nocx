/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/roles.assign.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the roles.assign JSON-RPC method (bead nocx-e6kn2): the full role table AFTER the write — the same shape roles.list declares, referenced cross-file. The write upserts one role's (endpoint, model) pair, or CLEARS it when both endpointId and model are absent; the result is the single table the renderer renders from, so the row and the response can never disagree.
 */
export interface RolesAssignResult {
  /**
   * Every role of the closed set, in product order, with the assignment just written (or cleared).
   */
  roles: Role[]
}
export interface Role {
  /**
   * The role name, a closed enum: 'answering' is the model the assistant speaks with; 'classifier' is the second model judging proposed tool calls (its own bead).
   */
  role: 'answering' | 'classifier'
  /**
   * The assigned endpoint's backend-minted id, or null when the role has no assignment.
   */
  endpointId: string | null
  /**
   * The assigned model id the endpoint's API understands (never the picker alias), or null when the role has no assignment.
   */
  model: string | null
}
