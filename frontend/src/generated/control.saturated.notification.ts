/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/control.saturated.notification.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Params of the control.saturated server-to-client notification. A refused control request with no id has no response to carry the -32004 error, so the server emits this instead, rate-limited, carrying method class and scope only. Both fields are server vocabulary: methodClass is the coarse class of the refused method, scope the saturated admission's name. Neither is free text from the request.
 */
export interface ControlSaturatedNotification {
  /**
   * Coarse server-side class of the refused control method (e.g. ssh, session, fs). Never the raw method name.
   */
  methodClass: string
  /**
   * The saturated resource, named by the server: the admission's identity (control.Admission.Name). Closed server vocabulary, never request text.
   */
  scope: string
}
