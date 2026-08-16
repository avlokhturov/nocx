// Notify RPC client — the renderer's path to notify.raise (ADR-0029).
// Sibling of DialogClient/LifecycleClient over the same Dispatcher.
//
// A program in a pane asks nocx to present a message by writing OSC 9 or
// OSC 777; the renderer parses it (osc-notification.ts) and raises it here.
// What crosses is exactly what the program supplied plus the addressing the
// backend needs: sessionId, title and body and NOTHING else. kind, trust,
// level, attribution and at are stamped by the backend from the method
// invoked and its own session registry — a schema proves a record's shape,
// never who assigned a field, so the protected fields are absent from the
// wire rather than validated on it.
//
// This is also why the renderer never says where a notification should go.
// It reports that a program asked; the router decides the destination, and
// there is no argument here by which a request could name one.

import type { Dispatcher } from './dispatcher'
import type { NotifyRaise } from './generated/notify.raise'

export class NotifyClient {
  constructor(private dispatcher: Dispatcher) {}

  /** Raise one program-requested notification for a session. Resolves when
   *  the backend has accepted it. Rejects when the method is unavailable
   *  (-32601, a backend built without the notify pipeline), when the session
   *  is not live on this connection (-32602), or when the pipeline refused
   *  the delivery (-32603) — every one of which the caller must treat as
   *  "this notification did not happen" rather than retrying. */
  raise(params: NotifyRaise): Promise<void> {
    return this.dispatcher.call('notify.raise', params)
  }
}
