/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/roles.list.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the roles.list JSON-RPC method (bead nocx-e6kn2): every model role in the CLOSED product set, with the (endpoint, model) pair each has been assigned. The role set is defined by the product, never by the user — a role is requested by a feature, so a user-invented name would have nobody to ask for it. An unassigned role is a row with null endpointId and model, never an absent row: the 'no model assigned' failure is a first-class state the surface renders, and the ask transaction refuses on it. endpointId and model are the ASSIGNED pair's identities; the renderer joins its own endpoint list for display names.
 */
export interface RolesListResult {
  /**
   * Every role of the closed set, in product order. Never null: an empty store still lists the roles, null-assigned.
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
