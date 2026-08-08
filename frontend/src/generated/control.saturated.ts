/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/control.saturated.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Data payload of the 'Control plane busy' JSON-RPC error (-32004) that refuses a control request when the bounded executor is saturated. The renderer reads data.reason to raise the saturation toast without the calling surface opting in. reason is FIXED vocabulary; scope is the saturated admission's server-defined name — the payload never carries request parameters or anything derived from them (any control frame may carry a secret).
 */
export interface ControlSaturated {
  /**
   * Fixed refusal vocabulary. Always control-saturated today; a new refusal class would extend the enum deliberately, schema and renderer together.
   */
  reason: 'control-saturated'
  /**
   * The saturated resource, named by the server: the admission's identity (control.Admission.Name). Closed server vocabulary, never request text.
   */
  scope: string
  /**
   * Whether retrying the request can succeed once capacity frees. Saturation is transient, so this is always true.
   */
  retryable: boolean
  /**
   * The server's suggested wait before retrying, in milliseconds. 0 means no hint — retry whenever.
   */
  retryAfterMs: number
}
