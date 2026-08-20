import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_OUTBOX_LIMITS,
  HistoryOutbox,
  payloadBytes,
  type OutboxEntry,
} from './history-outbox'

// The outbox (nocx-rtg0.4) under the loss policy nocx-rtg0.10 decided before
// the code. These assert the policy as behaviour: what is kept, what is lost
// when it cannot all be kept, and that the loss is a number somebody can read.

/** One record of a given size whose delivery the test controls. */
function entry(bytes: number, send: () => Promise<string>): OutboxEntry<string> {
  return { bytes, send }
}

const ok = (value: string) => () => Promise.resolve(value)
const fails = () => () => Promise.reject(new Error('socket down'))

describe('HistoryOutbox', () => {
  it('sends straight through when the socket is up, and queues nothing', async () => {
    const box = new HistoryOutbox()
    await expect(box.submit(entry(10, ok('ack')))).resolves.toBe('ack')
    expect(box.stats()).toEqual({ dropped: 0, pending: 0, bytes: 0 })
  })

  it('keeps a record the socket refused, and answers null to the caller', async () => {
    // Null is what recordCommand has always answered on failure, so a block
    // that treats it as "nothing to show" keeps working unchanged.
    const box = new HistoryOutbox()
    await expect(box.submit(entry(10, fails()))).resolves.toBeNull()
    expect(box.stats().pending).toBe(1)
  })

  it('delivers what it kept, in submission order, when the socket comes back', async () => {
    const box = new HistoryOutbox()
    const delivered: string[] = []
    let up = false
    const record = (name: string) =>
      entry(10, () => {
        if (!up) return Promise.reject(new Error('socket down'))
        delivered.push(name)
        return Promise.resolve(name)
      })

    await box.submit(record('first'))
    await box.submit(record('second'))
    expect(box.stats().pending).toBe(2)

    up = true
    await box.drain()

    expect(delivered).toEqual(['first', 'second'])
    expect(box.stats().pending).toBe(0)
    expect(box.stats().bytes).toBe(0)
  })

  it('stops draining at the first failure rather than skipping past it', async () => {
    // The queue is in submission order. Draining past a failure would land a
    // later command while an earlier one is still waiting, which reorders a
    // person's history for a reason they can never see.
    const box = new HistoryOutbox()
    const delivered: string[] = []
    box.enqueue(entry(10, () => Promise.reject(new Error('still down'))))
    box.enqueue(
      entry(10, () => {
        delivered.push('second')
        return Promise.resolve('second')
      }),
    )

    await box.drain()

    expect(delivered).toEqual([])
    expect(box.stats().pending).toBe(2)
  })

  it('drops the OLDEST when the count bound bites, and counts every drop', async () => {
    // Oldest, because the newest records are the commands still on screen.
    const box = new HistoryOutbox({ maxEntries: 2, maxBytes: 1 << 20 })
    const delivered: string[] = []
    let up = false
    const record = (name: string) =>
      entry(10, () => {
        if (!up) return Promise.reject(new Error('down'))
        delivered.push(name)
        return Promise.resolve(name)
      })

    await box.submit(record('one'))
    await box.submit(record('two'))
    await box.submit(record('three'))

    expect(box.stats().pending).toBe(2)
    expect(box.stats().dropped).toBe(1)

    up = true
    await box.drain()
    expect(delivered).toEqual(['two', 'three'])
  })

  it('drops on the BYTE bound too, because a count alone is not a memory bound', async () => {
    // One envelope is bounded on the wire at 16384 intent characters plus
    // 4096 of cwd, so a count that looks small can still be megabytes.
    const box = new HistoryOutbox({ maxEntries: 1000, maxBytes: 100 })
    await box.submit(entry(60, fails()))
    await box.submit(entry(60, fails()))

    expect(box.stats().pending).toBe(1)
    expect(box.stats().dropped).toBe(1)
    expect(box.stats().bytes).toBe(60)
  })

  it('reports what it is holding as well as what it lost', async () => {
    const box = new HistoryOutbox()
    await box.submit(entry(40, fails()))
    await box.submit(entry(60, fails()))
    expect(box.stats()).toEqual({ dropped: 0, pending: 2, bytes: 100 })
  })

  it('does not run two drains at once', async () => {
    // A second drain while one is running would send the same record twice.
    const box = new HistoryOutbox()
    let sends = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    box.enqueue(
      entry(10, async () => {
        sends += 1
        await gate
        return 'ack'
      }),
    )

    const first = box.drain()
    const second = box.drain()
    release()
    await Promise.all([first, second])

    expect(sends).toBe(1)
    expect(box.stats().pending).toBe(0)
  })

  it('carries the policy the bead recorded, so a change to it is deliberate', () => {
    expect(DEFAULT_OUTBOX_LIMITS.maxEntries).toBe(512)
    expect(DEFAULT_OUTBOX_LIMITS.maxBytes).toBe(1024 * 1024)
  })
})

describe('payloadBytes', () => {
  it('measures what the socket will carry, not what a guess would', () => {
    expect(payloadBytes({ command: 'ls' })).toBe(JSON.stringify({ command: 'ls' }).length)
  })

  it('counts multi-byte characters as the bytes they are', () => {
    // A count in UTF-16 units would under-count a command in Cyrillic or an
    // emoji by half, which is how a byte budget stops being one.
    expect(payloadBytes('привет')).toBeGreaterThan('привет'.length)
  })

  it('charges an unserialisable payload nothing rather than throwing', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(payloadBytes(cyclic)).toBe(0)
  })
})

describe('the outbox does not block the terminal', () => {
  it('answers every submit even while every send fails', async () => {
    // §4.5: a command runs before it is recorded, always. N failing records
    // are N resolved promises and no rejection anywhere.
    const box = new HistoryOutbox({ maxEntries: 3, maxBytes: 1 << 20 })
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => box.submit(entry(10, fails()))),
    )
    expect(answers).toEqual(Array(10).fill(null))
    expect(box.stats().pending).toBe(3)
    expect(box.stats().dropped).toBe(7)
  })

  it('never rejects, whatever the send does', async () => {
    const box = new HistoryOutbox()
    const boom = vi.fn(() => {
      throw new Error('synchronous explosion')
    })
    await expect(box.submit({ bytes: 1, send: boom })).resolves.toBeNull()
  })
})
