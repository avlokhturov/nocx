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
import type { LifecycleRecoverAck } from '../generated/lifecycle.recoverAck'
import type { LifecycleEstablishAck } from '../generated/lifecycle.establishAck'
import type { LifecycleSubmitAttempt } from '../generated/lifecycle.submitAttempt'

/** One lifecycle fact, delivered to a subscriber with its lane intact. The
 *  lane is what lets the projection attach the fact to the right tab's state
 *  machine; a fact is routed to the lane's own session, and the renderer
 *  filters nothing. */
export type LifecycleFactHandler = (fact: LifecycleChanged) => void

/** The payload of lifecycle.submitAttempt: the app-owned half of a command's
 *  execution, declared before the bytes that can cause the shell's own start
 *  are written to the pty (ADR-0024 decision 5). The command text is the
 *  reference-intact record line — never the resolved send line. */
export interface LifecycleSubmitAttemptParams {
  /** The live domain to open the attempt on — the id the published
   *  prompt_ready fact carried. */
  readonly domain: string
  /** The app-owned command text as submitted. */
  readonly command: string
  /** The cwd the command runs in, captured at submit. */
  readonly cwd: string
  /** The host the command runs on, captured at submit. */
  readonly host: string
}

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

  /** Open an app-originated attempt on the live domain — the ordering seam
   *  of ADR-0024 decision 5. The renderer calls this BEFORE writing the
   *  command bytes to the pty; the later authenticated start attaches to the
   *  returned attempt and replaces nothing. Resolves with the attempt as the
   *  kernel created it. */
  submitAttempt(params: LifecycleSubmitAttemptParams): Promise<LifecycleSubmitAttempt> {
    return this.dispatcher.call('lifecycle.submitAttempt', params)
  }

  /** Acknowledge a restoration (ADR-0024 decision 8): the renderer matched
   *  the shell's one-shot recovery fence AND applied the conventional
   *  presentation, so the lane may fall Lost → Native. The params are
   *  deliberately narrow — session identity and the recovery generation the
   *  lost fact carried; nothing else. The backend accepts only while the
   *  session is recovery-pending and alive, and the transition permits only
   *  Lost → Native. */
  recoverAck(sessionId: string, generation: string): Promise<LifecycleRecoverAck> {
    return this.dispatcher.call('lifecycle.recoverAck', { sessionId, generation })
  }

  /** Acknowledge an establishment (ADR-0024 decision 9): the renderer has
   *  processed the published prompt_ready fact for the exact {lane, domain,
   *  epoch, generation} and committed the presentation that makes an editor
   *  available. The backend flushes the pending accept only on this
   *  acknowledgement — no acknowledgement, no accept, and the shell's
   *  bounded handshake wait expires with its native prompt visible
   *  (fail-open). The params are narrow: session identity, the lane/domain/
   *  epoch addressing tuple and the backend-minted generation the fact
   *  carried. The call is fire-and-forget from the renderer: a refusal (a
   *  stale generation, a superseded establishment) is the backend's own
   *  bookkeeping, and the session stays conventional. */
  establishAck(
    sessionId: string,
    lane: string,
    domain: string,
    epoch: number,
    generation: string,
  ): Promise<LifecycleEstablishAck> {
    return this.dispatcher.call('lifecycle.establishAck', {
      sessionId,
      lane,
      domain,
      epoch,
      generation,
    })
  }
}
