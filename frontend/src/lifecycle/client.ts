// LifecycleClient — the renderer's subscription seam for the lifecycle.changed
// notification (ADR-0024 decision 7; contracts/lifecycle.changed.schema.json).
//
// Authentication terminates in the backend. This client never sees a raw
// channel frame, a capability, or a sequence counter — only the schema-checked
// published fact (internal/lifecyclepub), which is exactly what the kernel
// concluded. The renderer validates legal application transitions and can
// construct no authority of its own; this file is the thin consumer that makes
// the generated type reachable end to end, and the two-axis state machine
// (ADR-0024 decision 6) builds on the facts it exposes.
//
// The wire shape is guarded at the boundary like files.changed and git.changed
// (the same unsolicited-notification defect class): a payload without a string
// lane is not a fact and is not delivered.

import type { Dispatcher } from '../dispatcher'
import type { LifecycleChanged } from '../generated/lifecycle.changed'

/** One lifecycle fact, delivered to a subscriber with its lane intact. The
 *  lane is what lets the projection attach the fact to the right tab's state
 *  machine; a fact is routed to the lane's own session, and the renderer
 *  filters nothing. */
export type LifecycleFactHandler = (fact: LifecycleChanged) => void

export class LifecycleClient {
  constructor(private dispatcher: Dispatcher) {}

  /** Subscribe to the server-initiated lifecycle.changed notification: the
   *  per-lane authority axis (Native | PromptReady(domain) | Running(attempt)
   *  | Desynchronized(domain) | Lost). Returns the unsubscribe. */
  subscribeLifecycleChanged(handler: LifecycleFactHandler): () => void {
    return this.dispatcher.subscribe('lifecycle.changed', (params: unknown) => {
      const p = params as LifecycleChanged
      if (p && typeof p.lane === 'string') handler(p)
    })
  }
}
