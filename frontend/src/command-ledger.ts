// Command ledger model (ADR-0008). A keyboard-first structural index of
// trusted command landmarks over a real terminal — not cards. Each OSC 133
// command cycle becomes a compact record with app-owned command text, cwd,
// host, timestamps, status, and exit code. Output bytes are never retained.
//
// Trust logic mirrors input-state.ts §reduce: a clean A→B→C→D cycle is
// trusted; an orphan C, a D with no C, or an A interrupting a running
// command clears trust.

export type CommandStatus = 'running' | 'success' | 'failure' | 'interrupted' | 'unknown'

/**
 * Why a running record was finalized without its own D. Rendered by the
 * scrollback; never persisted — the history contract (history.query) carries
 * no reason, so this is presentation-side knowledge only.
 */
export type InterruptReason = 'transition-lost'

/**
 * Lifecycle of an environment-transition record (N6). `entered` is a
 * lifecycle state, NEVER a CommandStatus: an entered record is dormant —
 * open, not running, invisible as a block, excluded from persisted history —
 * until the local D completes it ('completed').
 */
export type TransitionLifecycle = 'entered' | 'completed'

export interface CommandRecord {
  readonly id: number
  readonly command: string
  readonly cwd: string
  readonly host: string
  status: CommandStatus
  exitCode: number | null
  startedAt: number | null
  endedAt: number | null
  trusted: boolean
  /** Live marker line accessor — read fresh, never cached. */
  readonly lineOf: () => number | undefined
  disposed: boolean
  /** Set when this record is an environment transition (enter() succeeded).
   *  'entered' = dormant: open, not running, excluded from history until the
   *  local D. 'completed' = the local D arrived; status/exitCode/endedAt are
   *  final and onComplete has fired exactly once. Never a CommandStatus. */
  transition?: TransitionLifecycle
  /** Why a running command was finalized without its own D — set only on
   *  'interrupted'/'unknown' records, currently only 'transition-lost' (the
   *  environment left before the command finished). */
  reason?: InterruptReason
}

export interface LedgerOpts {
  /**
   * Injectable wall clock in Unix epoch milliseconds (`Date.now()` units).
   * startedAt/endedAt are persisted, survive a restart, and render as
   * "3 days ago" across sessions — only a wall clock can express that.
   * A monotonic clock (`performance.now()`, milliseconds since page load)
   * would stamp values the store reads as January 1970 and sweeps the
   * moment the row is written (nocx-rtg0.16). If a duration in the ledger
   * ever needs monotonic time, keep a second, separate clock for it —
   * never one clock serving both meanings.
   */
  now: () => number
  /**
   * Called once when a record reaches a terminal state — the OSC 133 D with
   * its exit code, an A interrupting it, an open() while it is still
   * running, or a finalize at reset/exit. The record's status, exitCode and
   * endedAt are final; the caller persists it (history.record, nocx-rtg0.13)
   * or drops it. Never called twice for the same record.
   */
  onComplete?: (rec: CommandRecord) => void
}

type MarkerEvent = 'A' | 'B' | 'C' | 'D'

/**
 * Internal tracking state for the current prompt/command cycle.
 * Reset on any break in the trusted sequence.
 */
interface CycleState {
  /** Did we see a clean A (arrived from RAW or finished command)? */
  sawCleanA: boolean
  /** Did the B marker confirm ownership after A? */
  sawB: boolean
  /** The record currently in the running slot (C received, D not yet). */
  running: CommandRecord | null
}

function createCycle(): CycleState {
  return { sawCleanA: false, sawB: false, running: null }
}

export class CommandLedger {
  private _records: CommandRecord[] = []
  private _nextId = 1
  private readonly _now: () => number
  private readonly _onComplete: ((rec: CommandRecord) => void) | undefined
  private _cycle: CycleState = createCycle()
  /** The dormant ('entered') environment-transition record, if any. Never in
   *  the running slot; completed exactly once by completeTransition. */
  private _transition: CommandRecord | null = null

  constructor(opts: LedgerOpts) {
    this._now = opts.now
    this._onComplete = opts.onComplete
  }

  /**
   * Open a new command record. The record starts with status 'unknown' and
   * is transitioned to 'running' when the OSC 133 C marker arrives.
   *
   * @param command The app-owned submitted command text (from the DOM editor).
   * @param cwd Current working directory at submission time.
   * @param host Empty for local shells, hostname for SSH.
   * @param lineOf An opaque accessor backed by a live xterm IMarker.
   */
  open(
    command: string,
    cwd: string,
    host: string,
    lineOf: () => number | undefined,
  ): CommandRecord {
    if (!command) throw new Error('command must not be empty')

    // L2: open() while a record is still running finalizes the old one.
    if (this._cycle.running) {
      this._finalizeRunning()
    }

    const rec: CommandRecord = {
      id: this._nextId++,
      command,
      cwd,
      host,
      status: 'unknown',
      exitCode: null,
      startedAt: null,
      endedAt: null,
      trusted: false,
      lineOf,
      disposed: false,
    }
    this._records.push(rec)
    return rec
  }

  /**
   * Feed an OSC 133 marker into the ledger. Advances the current cycle
   * state and transitions open records between statuses.
   */
  onMarker(kind: MarkerEvent, exitCode?: number): void {
    switch (kind) {
      case 'A': {
        // A fresh prompt. If a record is currently running and this A
        // interrupts it (no D arrived), finalize it.
        if (this._cycle.running) {
          this._cycle.running.status = this._cycle.running.trusted ? 'interrupted' : 'unknown'
          this._cycle.running.endedAt = this._now()
          this._emitComplete(this._cycle.running)
        }
        // Start a new prompt cycle. Trusted only when we didn't interrupt
        // a running command — i.e. the cycle was idle or completed.
        this._cycle = {
          sawCleanA: this._cycle.running === null,
          sawB: false,
          running: null,
        }
        break
      }
      case 'B': {
        // B grants ownership only when a clean A preceded it (mirrors
        // input-state.ts: gating on trusted closes the B,B latch).
        if (this._cycle.sawCleanA) {
          this._cycle.sawB = true
        }
        break
      }
      case 'C': {
        // Command output start. Find the most recently opened record that is
        // still pending ('unknown') and transition it to running.
        const pending = this._findPending()
        if (pending) {
          pending.status = 'running'
          pending.startedAt = this._now()
          // Trusted only when a clean A→B sequence preceded this C.
          pending.trusted = this._cycle.sawCleanA && this._cycle.sawB
          this._cycle.running = pending
        }
        break
      }
      case 'D': {
        // Command finished. Only meaningful while a record is running.
        if (this._cycle.running) {
          const rec = this._cycle.running
          rec.endedAt = this._now()
          if (exitCode !== undefined) {
            rec.exitCode = exitCode
          }
          // L1: D with no exit code known → 'unknown', not 'failure'.
          rec.status =
            rec.exitCode === 0 ? 'success' : rec.exitCode !== null ? 'failure' : 'unknown'
          this._cycle = createCycle()
          this._emitComplete(rec)
        }
        break
      }
    }
  }

  /** All records, oldest first. Returns a defensive copy. */
  records(): readonly CommandRecord[] {
    return [...this._records]
  }

  /** Mark a record as disposed (called when its marker is trimmed). Idempotent. */
  dispose(id: number): void {
    const rec = this._records.find((r) => r.id === id)
    if (rec && !rec.disposed) {
      rec.disposed = true
    }
  }

  /** Look up a record by id. Returns undefined if not found. */
  resolveID(id: number): CommandRecord | undefined {
    return this._records.find((r) => r.id === id)
  }

  /** The dormant ('entered') environment-transition record, or null when none
   *  is dormant. A completed transition is no longer dormant (returns null);
   *  the record itself stays visible in records() with transition
   *  'completed'. */
  get transitionRecord(): CommandRecord | null {
    return this._transition
  }

  /**
   * Mark the given record as having entered an environment (N6): it leaves
   * the running slot WITHOUT completing and becomes a dormant transition
   * record — open, not running, invisible as a block — completed later,
   * exactly once, by completeTransition() when the local D arrives.
   *
   * Call this at entry (expected passport → tagged A → B), BEFORE the remote
   * prompt's A reaches onMarker — an A while the ssh record still occupies
   * the running slot would interrupt it exactly as today.
   *
   * Refuses (returns false) when a transition record already exists — a
   * second ssh from inside must never nest — or when the record cannot
   * enter (unknown id, disposed, already a transition, or already finished).
   */
  enter(id: number): boolean {
    if (this._transition) return false
    const rec = this._records.find((r) => r.id === id)
    if (!rec || rec.disposed || rec.transition !== undefined || rec.endedAt !== null) {
      return false
    }
    // The ssh process is alive until the local D: 'running' is the honest
    // CommandStatus, and it keeps the dormant record out of _findPending so
    // a later C can never restart it.
    rec.status = 'running'
    rec.transition = 'entered'
    if (this._cycle.running === rec) {
      this._cycle.running = null
    }
    this._transition = rec
    return true
  }

  /**
   * The local D arrived: the environment the transition record entered is
   * gone. Any command still running is cut short — 'interrupted' (trusted)
   * or 'unknown' (untrusted), with reason 'transition-lost' — and the local
   * D's code is never assigned to it. Then the dormant transition record is
   * completed with the REAL exit code, reaching onComplete (history.record)
   * exactly once.
   *
   * The local D must be delivered here, never as an onMarker('D'): a marker
   * D only closes a running command and must never complete the transition.
   *
   * No-op (returns null) when no transition is dormant; a second call
   * completes nothing.
   */
  completeTransition(exitCode: number | null): CommandRecord | null {
    const trans = this._transition
    if (!trans) return null

    // Finalize the transition record FIRST, and clear the pointer before any
    // onComplete can run: a reentrant completeTransition from the interrupted
    // command's callback must find nothing left to complete.
    if (exitCode !== undefined) {
      trans.exitCode = exitCode
    }
    trans.endedAt = this._now()
    trans.status =
      trans.exitCode === 0 ? 'success' : trans.exitCode !== null ? 'failure' : 'unknown'
    trans.transition = 'completed'
    this._transition = null

    // Cut the active remote command short and clear the slot BEFORE its
    // onComplete can run — a reentrant finalizeOpen or marker must not
    // re-emit it. The local D's code is never assigned to it.
    const interrupted = this._cycle.running
    if (interrupted) {
      interrupted.status = interrupted.trusted ? 'interrupted' : 'unknown'
      interrupted.reason = 'transition-lost'
      interrupted.endedAt = this._now()
    }
    // The session this transition belonged to is over — the cycle restarts.
    this._cycle = createCycle()

    // Emit in causal order: the command the environment cut short, then the
    // transition record itself — each exactly once.
    if (interrupted) this._emitComplete(interrupted)
    this._emitComplete(trans)
    return trans
  }

  /** B3: finalize any still-running record (fail-open on reset/exit). */
  finalizeOpen(): void {
    this._finalizeRunning()
  }

  /** Internal: finalize the current running record and reset cycle state. */
  private _finalizeRunning(): void {
    if (this._cycle.running) {
      this._cycle.running.status = this._cycle.running.trusted ? 'interrupted' : 'unknown'
      this._cycle.running.endedAt = this._now()
      this._emitComplete(this._cycle.running)
    }
    this._cycle = createCycle()
  }

  /** Internal: hand a finalized record to the persistence seam exactly once. */
  private _emitComplete(rec: CommandRecord): void {
    this._onComplete?.(rec)
  }

  /**
   * Find the most recently opened record that is still pending (status
   * 'unknown'). Used by the C marker to transition exactly one record.
   */
  private _findPending(): CommandRecord | null {
    for (let i = this._records.length - 1; i >= 0; i--) {
      if (this._records[i].status === 'unknown') return this._records[i]
    }
    return null
  }
}
