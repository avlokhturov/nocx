// The disposable projections (ADR-0024 §5–§7, bead nocx-u7uh.7): the
// command ledger, history persistence and the block model consume the
// kernel — the published-fact state machine in lifecycle/state.ts — and
// hold no lifecycle state of their own. This module is the one observer:
// it subscribes to kernel changes and drives the projections from the
// kernel's current state. The byte stream reaches none of them; the eslint
// Rule 9 boundary keeps the parsing surface out of this directory.
//
// The attempt is the authority everywhere. The ledger binds its pending
// app-owned record to the published attempt and completes it only from the
// attempt (exit status exactly once; an abandoned attempt is `unknown` and
// never successful). History persistence is invoked only for a COMPLETED
// attempt and only when an app-owned record exists — a shell-originated
// attempt opens no record, so its command text, which may carry a literal
// password, persists nowhere (the command-text decision this bead owns:
// authenticated origin makes the completion trustworthy, never the line).
// The block model opens on an attempt and freezes on its completion — the
// VISUAL freeze may wait for the render fence (u7uh.8), but this module
// never does: logical completion (ledger, history) lands on the event alone.
// The DOM half is a port (BlockProjectionPort): the composition root
// (terminal-content) implements it over the scrollback controller; this
// module never touches the DOM, which is what makes it testable without a
// renderer and keeps stream parsing out of the authority path.

import { CommandLedger } from '../command-ledger'
import type { CommandRecord } from '../command-ledger'
import type { ExecutionAttempt, LifecycleKernel } from './state'

/** The block-model half of the projection, implemented by the composition
 *  root over the scrollback controller. Each operation is attempt-keyed:
 *  the DOM freeze only ever acts on the block bound to the attempt. */
export interface BlockProjectionPort {
  /** Bind the running block (opened at the app-owned submit) to the
   *  published attempt. */
  bindBlock(attempt: ExecutionAttempt): void
  /** Open a running block for a shell-originated attempt — no pending app
   *  record exists, so the block is the structure the attempt earns
   *  (ADR-0024 §5), and nothing of it persists. */
  openBlock(attempt: ExecutionAttempt): void
  /** Freeze the bound block with the attempt's authenticated exit status.
   *  The port may defer the VISUAL freeze until the render fence (u7uh.8)
   *  proves where the output ended; the projection never waits for that —
   *  the ledger and history land on this event alone. */
  freezeBlock(attempt: ExecutionAttempt): void
  /** Freeze the bound block as abandoned — the attempt went `unknown`. */
  abandonBlock(attempt: ExecutionAttempt): void
}

/** The history half: persists a completed app-owned record, authorized by
 *  the completed attempt. Resolves with the store's ack or null. */
export type HistoryPort = (rec: CommandRecord, attempt: ExecutionAttempt) => Promise<unknown>

/** One observer that drives the ledger, history and block projections from
 *  the kernel. It holds no lifecycle state: the per-attempt `_bound` and
 *  `_done` sets are idempotency bookkeeping, not a second model — each
 *  published fact still changes exactly the kernel, and the projections
 *  re-read it on every change. */
export class LifecycleProjections {
  /** Attempt ids the projections already bound a record/block to. */
  private readonly _bound = new Set<string>()
  /** Attempt ids already terminal-processed (completed or abandoned) —
   *  an attempt's exit status is applied exactly once. */
  private readonly _done = new Set<string>()
  private _unsub: (() => void) | null = null

  constructor(
    private readonly kernel: LifecycleKernel,
    private readonly ledger: CommandLedger,
    private readonly blocks: BlockProjectionPort,
    private readonly persist: HistoryPort,
  ) {}

  /** Subscribe to kernel changes and drive the projections once with the
   *  current state (a no-op until the first fact). */
  attach(): void {
    if (this._unsub !== null) return
    this._unsub = this.kernel.onChange(() => this.pump())
    this.pump()
  }

  detach(): void {
    this._unsub?.()
    this._unsub = null
  }

  /** Reconcile the projections with the kernel's current state. The ONLY
   *  input is kernel state; a stream event can never reach this method. */
  pump(): void {
    const state = this.kernel.state
    if (state.kind === 'lost') {
      // The kernel abandoned every open attempt of the lane (decision 8):
      // the bound projections must not keep a running slot, and the bound
      // records must leave `running` — as `unknown`, never success.
      this.abandonBound()
      return
    }
    if (state.kind !== 'running') return
    const attempt = state.attempt

    if (attempt.state === 'open') {
      if (this._bound.has(attempt.id)) return
      this._bound.add(attempt.id)
      const rec = this.ledger.bindAttempt(attempt.id)
      if (rec === null) {
        // Shell-originated: the attempt's line is the shell's own, which
        // may carry a literal password — no ledger record, no history.
        this.blocks.openBlock(attempt)
      } else {
        this.blocks.bindBlock(attempt)
      }
      return
    }

    // Terminal: completed or unknown. Process exactly once.
    if (this._done.has(attempt.id)) return
    this._done.add(attempt.id)

    const rec = this.ledger.complete(attempt)
    if (attempt.state === 'completed') {
      // Only a completed attempt persists, and only through its app-owned
      // record — the attempt's own command text never crosses to the store.
      if (rec !== null) void this.persist(rec, attempt)
      this.blocks.freezeBlock(attempt)
    } else {
      this.blocks.abandonBlock(attempt)
    }
  }

  /** Abandon every bound projection: the lane fell to Lost, so each bound
   *  attempt is `unknown` in the kernel and the records must follow. */
  private abandonBound(): void {
    for (const id of this._bound) {
      if (this._done.has(id)) continue
      this._done.add(id)
      const attempt = this.kernel.attempt(id)
      if (attempt === undefined) continue
      this.ledger.complete(attempt)
      this.blocks.abandonBlock(attempt)
    }
  }
}
