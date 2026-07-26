// SettingsObserver consumes the backend-originated settings.changed notification
// and signals invalidation to its handler. It does NOT carry values — on any
// change, the handler refetches the full snapshot from the backend.
//
// Revision semantics (design §A.4):
//  - Expected successor revision → handler called (incremental refresh)
//  - Gap (unexpectedly high revision) → handler called (full snapshot fetch)
//  - Reconnect → handler called (full snapshot fetch)
//  - Duplicate or older revision → ignored

import { Dispatcher } from './dispatcher'

export interface SettingsChangeParams {
  revision: number
  keys: string[]
}

export type InvalidationHandler = () => void

export class SettingsObserver {
  private expectedRevision = -1
  private unsub: (() => void) | null = null
  private unsubConnect: (() => void) | null = null
  private active = false

  constructor(private dispatcher: Dispatcher) {}

  /** Start listening for settings.changed notifications.  Call setRevision()
   *  after the initial snapshot fetch so the observer knows the baseline. */
  start(handler: InvalidationHandler): void {
    if (this.active) return
    this.active = true

    this.unsub = this.dispatcher.subscribe('settings.changed', (params: unknown) => {
      if (!this.active) return
      const p = params as SettingsChangeParams
      if (!p || typeof p.revision !== 'number') return

      if (this.expectedRevision < 0) {
        this.expectedRevision = p.revision + 1
        handler()
        return
      }

      if (p.revision < this.expectedRevision) return

      this.expectedRevision = p.revision + 1
      handler()
    })

    // On reconnect the revision counter may reset (it is in-memory, §A.1).
    // Reset our tracker and trigger a full snapshot fetch.
    this.unsubConnect = this.dispatcher.onConnect(() => {
      if (!this.active) return
      this.expectedRevision = -1
      handler()
    })
  }

  /** Set the expected next revision from a snapshot. Call after every
   *  successful snapshot fetch so gap detection works correctly. */
  setRevision(rev: number): void {
    this.expectedRevision = rev + 1
  }

  stop(): void {
    this.active = false
    this.unsub?.()
    this.unsub = null
    this.unsubConnect?.()
    this.unsubConnect = null
  }
}
