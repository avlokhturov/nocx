// Command ledger model (ADR-0008) — SEVERED by ADR-0024. The ledger is the
// completion projection: app-owned command records that no stream marker may
// populate or complete. `onMarker` (the anonymous entry point for OSC 133
// kinds) is deleted, and with it the marker cycle (A→B→C→D trust tracking),
// the `trusted` boolean, and the N6 environment-transition machinery
// (enter/completeTransition — stream-driven activation and completion).
// A record is opened at the app-owned submit with its start time (ADR-0024
// §5: the attempt exists, started, before any bytes that could cause the
// shell's own start event are written) and nothing completes it in the
// severed world — there is no authenticated completion — so the persistence
// seam is gone and history recording has no terminal caller. The migration
// bead reconnects completion to authenticated domain events.
// The status vocabulary of a ledger record. NOT exported on purpose: nothing
// imports it today (recall reads the `status` field, never the type), and an
// exported-but-unused type is exactly the dead export the knip ratchet
// exists to catch. The migration bead — the one that reconnects completion
// to authenticated domain events (ADR-0024 §5) — is the first consumer that
// will need to name a status across modules; it re-exports this type with
// its consumer in the same commit.
type CommandStatus = 'running' | 'success' | 'failure' | 'interrupted' | 'unknown'

export interface CommandRecord {
  readonly id: number
  readonly command: string
  readonly cwd: string
  readonly host: string
  status: CommandStatus
  exitCode: number | null
  startedAt: number | null
  endedAt: number | null
  /** Live marker line accessor — read fresh, never cached. */
  readonly lineOf: () => number | undefined
  disposed: boolean
}

export interface LedgerOpts {
  /**
   * Injectable wall clock in Unix epoch milliseconds (`Date.now()` units).
   * startedAt is persisted, survives a restart, and renders as "3 days ago"
   * across sessions — only a wall clock can express that. A monotonic clock
   * (`performance.now()`, milliseconds since page load) would stamp values
   * the store reads as January 1970 and sweeps the moment the row is written
   * (nocx-rtg0.16). If a duration in the ledger ever needs monotonic time,
   * keep a second, separate clock for it — never one clock serving both
   * meanings.
   */
  now: () => number
}

export class CommandLedger {
  private _records: CommandRecord[] = []
  private _nextId = 1
  private readonly _now: () => number

  constructor(opts: LedgerOpts) {
    this._now = opts.now
  }

  /**
   * Open a new command record at the app-owned submit (ADR-0024 §5: the
   * attempt exists with its start time before any bytes that could cause the
   * shell's own start event are written). The record is 'running' from
   * submit; without an authenticated completion nothing may close it, assign
   * an exit code or persist it.
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

    const rec: CommandRecord = {
      id: this._nextId++,
      command,
      cwd,
      host,
      status: 'running',
      exitCode: null,
      startedAt: this._now(),
      endedAt: null,
      lineOf,
      disposed: false,
    }
    this._records.push(rec)
    return rec
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
}
