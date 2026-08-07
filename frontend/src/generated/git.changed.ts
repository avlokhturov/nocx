/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/git.changed.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * The git.changed JSON-RPC notification: server-initiated and unsolicited, so it has no request to correlate against and no caller checking its shape — which is exactly where an addressing or shape defect would hide, and why the design gives it the same three checks as a method (spec §5.3). This schema covers the params object only, exactly as files.changed's does. The notification announces that a binding is gone. Its destination is resolved at emit time — the binding records its sessionId, and the backend writes to that session's current subscriber — which is what survives an AD-9 reconnect; a binding is bounded by its session, never by a WebSocket. The one exception is session teardown, where emit-time lookup finds nobody (removeRx ran first): there the subscriber is captured before removal and the notification is written to that capture. reason never says 'connection lost': a lost connection is not something you can tell the connection that was lost. There is exactly one reason, sessionClosed, with exactly one producer: the session teardown path that already closes a session's bindings.
 */
export interface GitChangedNotification {
  /**
   * The binding that is gone. The store drops it and re-resolves through git.open when the panel needs a repository again; an in-flight call that loses the race answers unknownBinding, which is the correct answer.
   */
  bindingId: string
  /**
   * Why the binding is gone. Exactly one value exists: sessionClosed. A repository that disappears under a live binding is discovered the ordinary way instead — the next git.status fails and the store re-resolves through git.open, which answers notARepository.
   */
  reason: 'sessionClosed'
}
