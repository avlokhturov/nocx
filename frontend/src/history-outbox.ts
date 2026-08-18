// The outbox: a bounded queue of records the socket has not acknowledged
// (nocx-rtg0.4), governed by the loss policy nocx-rtg0.10 decided before any
// of this existed.
//
// WHY IT EXISTS. AD-9 replays PTY bytes; it says nothing about the control
// plane. A socket that drops between a command finishing and history.record
// landing loses that command silently, and a memory product that forgets when
// the network hiccups is not a memory product.
//
// WHY IT IS BOUNDED, AND BOUNDED BY TWO NUMBERS. §4.5 forbids backpressure on
// the terminal — a command runs before it is recorded, always — so the only
// remaining choices are lose entries, grow without bound, or spool to disk.
// Unbounded growth is a leak; a spool is almost a second database and would
// need its own key and format. So: bounded loss.
//
// The bound is a COUNT and a BYTE BUDGET, whichever bites first, for the same
// reason the retention budget is two numbers — the design records that
// conflating them shipped a defect. A count is what a person reasons about;
// only bytes prevent the leak. One envelope is bounded on the wire at 16384
// intent characters plus 4096 of cwd, so 512 records is anywhere between
// ~75 KiB and ~10 MB: a count alone is not a memory bound at all.
//
// WHY OVERFLOW DROPS THE OLDEST. The newest records are the commands still on
// screen, the ones a person is looking at; the oldest are already scrolled
// away. Dropping the newest would discard exactly what is being watched.

/** One queued record and what it costs. `send` is the call to retry. */
export interface OutboxEntry<T> {
  /** The wire payload's size in bytes, as the byte budget counts it. */
  readonly bytes: number
  /** Deliver this record. Rejects when the socket or the store refused. */
  readonly send: () => Promise<T>
}

/**
 * The bound. Both numbers are enforced; whichever bites first evicts.
 *
 * These defaults are nocx-rtg0.10's, recorded on the bead before the code:
 * 512 unacknowledged records — three lifecycle events per command in the
 * fuller protocol, so on the order of a hundred and seventy commands of
 * disconnected work — and 1 MiB of queued payload.
 */
export interface OutboxLimits {
  readonly maxEntries: number
  readonly maxBytes: number
}

export const DEFAULT_OUTBOX_LIMITS: OutboxLimits = {
  maxEntries: 512,
  maxBytes: 1024 * 1024,
}

/** What the outbox has lost, and is still holding. Observable on purpose:
 *  "records that it did" (design §6.4) means a number somebody can assert on
 *  and a surface can render, not a line in a log. */
export interface OutboxStats {
  /** Records dropped to the bound, cumulative for the life of the outbox. */
  readonly dropped: number
  /** Records queued and not yet acknowledged. */
  readonly pending: number
  /** Bytes those pending records hold. */
  readonly bytes: number
}

/**
 * A queue that keeps trying, forgets the oldest when it is full, and says how
 * much it forgot.
 *
 * It is deliberately NOT durable across a renderer reload: that would be a
 * second store with its own key and format, which §6.4 rules out. The window
 * it covers is a socket drop, which is the failure AD-9 says will happen.
 */
export class HistoryOutbox {
  private queue: OutboxEntry<unknown>[] = []
  private bytes = 0
  private droppedCount = 0
  private draining = false

  constructor(private readonly limits: OutboxLimits = DEFAULT_OUTBOX_LIMITS) {}

  stats(): OutboxStats {
    return { dropped: this.droppedCount, pending: this.queue.length, bytes: this.bytes }
  }

  /**
   * Try to send now; queue for later if that fails.
   *
   * Resolves with the answer when it lands and with null when it did not —
   * the same shape recordCommand has always had, so a caller that treats a
   * failure as "nothing to show" keeps working unchanged. A queued record's
   * eventual delivery is NOT reported back: by then the block that asked has
   * its answer, and inventing a late one would move a receipt under a person
   * who has stopped looking.
   */
  async submit<T>(entry: OutboxEntry<T>): Promise<T | null> {
    try {
      return await entry.send()
    } catch {
      this.enqueue(entry)
      return null
    }
  }

  /** Queue without attempting — for a caller that already knows the socket
   *  is down and would only be adding a rejection to the console. */
  enqueue(entry: OutboxEntry<unknown>): void {
    this.queue.push(entry)
    this.bytes += entry.bytes
    this.evictToFit()
  }

  /**
   * Send everything queued, oldest first, and stop at the first failure.
   *
   * STOPPING IS THE POINT: the queue is in submission order, and draining
   * past a failure would deliver a later command while an earlier one is
   * still waiting. A second drain while one is running is a no-op rather than
   * a race — the running one owns the queue.
   */
  async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0]
        try {
          await next.send()
        } catch {
          return
        }
        // Re-check identity rather than assuming index 0 is still the same
        // entry: an eviction during the await may have dropped it, and
        // shifting blindly would then discard a record nobody sent.
        if (this.queue[0] === next) {
          this.queue.shift()
          this.bytes -= next.bytes
        }
      }
    } finally {
      this.draining = false
    }
  }

  /** Drop the oldest until both bounds hold. Each drop is counted, because a
   *  loss nobody can name is the failure this whole file exists to bound. */
  private evictToFit(): void {
    while (
      this.queue.length > this.limits.maxEntries ||
      (this.bytes > this.limits.maxBytes && this.queue.length > 0)
    ) {
      const oldest = this.queue.shift()
      if (!oldest) return
      this.bytes -= oldest.bytes
      this.droppedCount += 1
    }
  }
}

/** How many bytes a record costs the budget. JSON length rather than a
 *  guess: it is what the socket will carry, and it is exact. */
export function payloadBytes(params: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(params)).length
  } catch {
    // An unserialisable payload cannot be sent either; charge it nothing
    // rather than throwing inside a size calculation.
    return 0
  }
}
