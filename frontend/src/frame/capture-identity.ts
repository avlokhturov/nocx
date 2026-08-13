// Capture identity tracking (spec §2.3, bead nocx-3j9b).
//
// The identity is buffer instance + geometry + generation. The generation
// advances on onWriteParsed plus the explicit state-changing operations
// (buffer switch, resize, clear, reset) — NEVER on onRender: ADR-0005 forces
// periodic repaints on Linux/WebKitGTK, so a paint-driven generation would
// stale a motionless screen continuously, on one platform only.
//
// Deliberately conservative: a write that repaints identical cells still
// advances the generation. We prefer a false "it moved" (costs a re-ask) to
// a false "unchanged" (describes a screen that is gone).
//
// ADR-0029: generation inequality is a TRIGGER, never a verdict. This module
// reports comparability — same | moved | notComparable — and nothing here
// wires inequality to a refusal (that arrives with DRIVE), and no surface
// may present drift as "stale".
//
// The capture fence: write() queues parsing, so a snapshot taken mid-queue
// can hold row 1 from before a write and row 20 from after it — a state that
// never existed. awaitSettled() defers until no queued write is mid-parse.
// xterm fires onWriteParsed at the end of EVERY parse pass, which can be
// BETWEEN chunks of a large write, so the fence re-checks hasUnsettledWrite()
// after every fire and only opens when the final pass has settled.

import type { CaptureComparability, CaptureEventSource, CaptureIdentity } from './types'

export class CaptureIdentityTracker {
  private _generation = 0
  private _buffer: { kind: 'normal' } | { kind: 'alternate'; altSession: number } = {
    kind: 'normal',
  }
  private _altSession = 0
  /** Waiters for the next onWriteParsed fire — the fence's rendezvous. */
  private _writeParsedWaiters: Array<() => void> = []

  constructor(private readonly _source: CaptureEventSource) {
    _source.onWriteParsed(() => this._onWriteParsed())
    _source.onBufferChange((type) => this._onBufferChange(type))
    _source.onResize(() => this._onExplicitMutation())
    _source.onClear(() => this._onExplicitMutation())
    _source.onReset(() => this._onExplicitMutation())
  }

  /** The current capture identity. The buffer record is copied so a saved
   *  identity is a snapshot: mutating it cannot corrupt later comparisons. */
  identity(): CaptureIdentity {
    return {
      buffer:
        this._buffer.kind === 'alternate'
          ? { kind: 'alternate', altSession: this._buffer.altSession }
          : { kind: 'normal' },
      cols: this._source.cols,
      rows: this._source.rows,
      generation: this._generation,
    }
  }

  /** Compare a saved identity against the current one.
   *
   *  A buffer switch or a resize is NOT staleness — it is incomparability
   *  (the alt buffer's contents are discarded on exit; a resize reflows and
   *  shifts absolute line indices). Across that discontinuity the answer is
   *  `notComparable`, a distinct value, never a flag on `moved`. */
  compareIdentity(saved: CaptureIdentity): CaptureComparability {
    const current = this.identity()
    if (saved.buffer.kind !== current.buffer.kind) return { status: 'notComparable' }
    if (
      saved.buffer.kind === 'alternate' &&
      current.buffer.kind === 'alternate' &&
      saved.buffer.altSession !== current.buffer.altSession
    ) {
      return { status: 'notComparable' }
    }
    if (saved.cols !== current.cols || saved.rows !== current.rows) {
      return { status: 'notComparable' }
    }
    if (saved.generation !== current.generation) return { status: 'moved' }
    return { status: 'same' }
  }

  /** The capture fence. Resolves once no queued write is mid-parse; if
   *  nothing is queued it resolves immediately (no event may ever come).
   *
   *  Because the fire can land BETWEEN chunks of one large write, the loop
   *  re-checks hasUnsettledWrite() after every fire and waits for the pass
   *  that actually settles the queue. */
  async awaitSettled(): Promise<void> {
    while (this._source.hasUnsettledWrite()) {
      await this._waitForWriteParsed()
    }
  }

  private _waitForWriteParsed(): Promise<void> {
    return new Promise((resolve) => {
      // Subscribing a waiter is synchronous with the hasUnsettledWrite()
      // check that led here (both run in the same task), and a fire can only
      // arrive in a later task — so this waiter can never miss its event.
      this._writeParsedWaiters.push(resolve)
    })
  }

  private _onWriteParsed(): void {
    this._generation++
    const waiters = this._writeParsedWaiters
    this._writeParsedWaiters = []
    for (const w of waiters) w()
  }

  private _onBufferChange(type: 'normal' | 'alternate'): void {
    this._generation++
    if (type === 'alternate') {
      this._altSession++
      this._buffer = { kind: 'alternate', altSession: this._altSession }
    } else {
      this._buffer = { kind: 'normal' }
    }
  }

  private _onExplicitMutation(): void {
    this._generation++
  }
}
