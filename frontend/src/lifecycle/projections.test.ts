// The disposable projections (ADR-0024 §5–§7, bead nocx-u7uh.7): the
// ledger, history and the block model consume the kernel and hold no
// lifecycle state of their own. This module pins the projection contract:
// the published attempt is the only authority — an app-owned ledger record
// binds to it and closes only on it (exit status exactly once, abandoned
// never successful), history persists ONLY completed app-owned records
// (and never the attempt's own command text — the privacy rule), and the
// block model opens on an attempt and freezes on its completion. The
import { describe, it, expect, vi } from 'vitest'
import { LifecycleKernel } from './state'
import type { ExecutionAttempt } from './state'
import type { LifecycleChanged } from '../generated/lifecycle.changed'
import { CommandLedger } from '../command-ledger'
import type { CommandRecord } from '../command-ledger'
import { LifecycleProjections, type BlockProjectionPort } from './projections'

const LANE = 'lane-1'
const FENCE = 'a'.repeat(64)

function promptReady(domain = 'd1', epoch = 1): LifecycleChanged {
  return { lane: LANE, lifecycle: 'prompt_ready', domain, epoch }
}

function running(
  domain = 'd1',
  epoch = 1,
  attempt: Partial<NonNullable<LifecycleChanged['attempt']>> = {},
): LifecycleChanged {
  return {
    lane: LANE,
    lifecycle: 'running',
    domain,
    epoch,
    attempt: { id: 'att-1', state: 'open', ...attempt },
  }
}

function lostF(): LifecycleChanged {
  return { lane: LANE, lifecycle: 'lost' }
}

/** The block-port recorder: no DOM, just the ordered calls. */
class FakeBlocks implements BlockProjectionPort {
  readonly events: string[] = []
  bindBlock(a: ExecutionAttempt): void {
    this.events.push(`bind:${a.id}`)
  }
  openBlock(a: ExecutionAttempt): void {
    this.events.push(`open:${a.id}:${a.command ?? ''}`)
  }
  freezeBlock(a: ExecutionAttempt): void {
    this.events.push(`freeze:${a.id}:${a.exitCode ?? 'null'}`)
  }
  abandonBlock(a: ExecutionAttempt): void {
    this.events.push(`abandon:${a.id}`)
  }
}

function makeEnv() {
  const kernel = new LifecycleKernel()
  const ledger = new CommandLedger({ now: () => 1000 })
  const blocks = new FakeBlocks()
  const persist = vi.fn<(rec: CommandRecord, attempt: ExecutionAttempt) => Promise<unknown>>(() =>
    Promise.resolve(null),
  )
  const projections = new LifecycleProjections(kernel, ledger, blocks, persist)
  projections.attach()
  return { kernel, ledger, blocks, persist, projections }
}

describe('the projections consume the kernel (ADR-0024, bead nocx-u7uh.7)', () => {
  it('an app submit binds to the published attempt and completes on its authenticated completion — once', () => {
    const { kernel, ledger, blocks, persist } = makeEnv()
    // The editor submit: app-owned text, before any pty bytes.
    ledger.open('make {{secret:ci}}', '/repo', '', () => undefined)
    kernel.applyFact(promptReady())
    // The shell start attaches: the pending record binds to the attempt.
    kernel.applyFact(running('d1', 1, { id: 'att-1', origin: 'app', command: 'make sk-live' }))
    const rec = ledger.recordForAttempt('att-1')
    expect(rec).not.toBeUndefined()
    expect(rec?.command).toBe('make {{secret:ci}}') // app text, never the wire line
    expect(blocks.events).toEqual(['bind:att-1'])

    // The authenticated completion: exit status exactly once.
    kernel.applyFact(
      running('d1', 1, {
        id: 'att-1',
        state: 'completed',
        exitCode: 0,
        fence: FENCE,
        completedAt: '2026-08-08T12:00:02Z',
      }),
    )
    expect(rec?.status).toBe('success')
    expect(rec?.exitCode).toBe(0)
    expect(rec?.endedAt).toBe(1000)
    expect(persist).toHaveBeenCalledTimes(1)
    // The persisted record carries the app-owned text — never the attempt's.
    const [persisted] = persist.mock.calls[0]
    expect(persisted.command).toBe('make {{secret:ci}}')
    expect(persisted.status).toBe('success')
    expect(blocks.events).toEqual(['bind:att-1', 'freeze:att-1:0'])

    // A later change must not re-complete the same attempt.
    kernel.applyFact(nativeFact())
    expect(persist).toHaveBeenCalledTimes(1)
    expect(rec?.status).toBe('success')
  })

  it('an abandoned attempt is unknown, never successful, and persists nothing', () => {
    const { kernel, ledger, blocks, persist } = makeEnv()
    ledger.open('sleep 100', '/', '', () => undefined)
    kernel.applyFact(promptReady())
    kernel.applyFact(running('d1', 1, { id: 'att-1' }))
    kernel.applyFact(running('d1', 1, { id: 'att-1', state: 'unknown' }))
    const rec = ledger.recordForAttempt('att-1')
    expect(rec?.status).toBe('unknown')
    expect(rec?.exitCode).toBeNull()
    expect(rec?.endedAt).toBe(1000)
    expect(persist).not.toHaveBeenCalled()
    expect(blocks.events).toEqual(['bind:att-1', 'abandon:att-1'])
  })

  it('a shell-originated attempt opens a block but no ledger record and persists nothing', () => {
    const { kernel, ledger, blocks, persist } = makeEnv()
    // No submit: the user typed at the native prompt. The shell's line may
    // carry a literal password — it opens no record and persists nowhere
    // (the command-text decision this bead owns).
    kernel.applyFact(promptReady())
    kernel.applyFact(running('d1', 1, { id: 'att-9', origin: 'shell', command: 'ssh pi@host' }))
    expect(ledger.records()).toHaveLength(0)
    expect(blocks.events).toEqual(['open:att-9:ssh pi@host'])

    kernel.applyFact(
      running('d1', 1, { id: 'att-9', state: 'completed', exitCode: 1, fence: FENCE }),
    )
    expect(ledger.records()).toHaveLength(0)
    expect(persist).not.toHaveBeenCalled()
    expect(blocks.events).toEqual(['open:att-9:ssh pi@host', 'freeze:att-9:1'])
  })

  it('a completed fact with no prior open fact still completes the pending app record (reconnect replay)', () => {
    const { kernel, ledger, persist } = makeEnv()
    ledger.open('make', '/', '', () => undefined)
    kernel.applyFact(promptReady())
    // The open fact was lost (reattach replay of the completed state): the
    // authenticated completion resolves the single pending app record.
    kernel.applyFact(
      running('d1', 1, { id: 'att-1', state: 'completed', exitCode: 2, fence: FENCE }),
    )
    const rec = ledger.records()[0]
    expect(rec.status).toBe('failure')
    expect(rec.exitCode).toBe(2)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('logical completion does not wait for the render fence — ledger and history land on the event alone (u7uh.8)', () => {
    const { kernel, ledger, blocks, persist } = makeEnv()
    ledger.open('make', '/repo', '', () => undefined)
    kernel.applyFact(promptReady())
    kernel.applyFact(running('d1', 1, { id: 'att-1', origin: 'app', command: 'make' }))
    blocks.events.length = 0
    persist.mockClear()

    // The completion event arrives with its fence still in flight on the
    // pty. The exit status is recorded and history is written NOW — nothing
    // in this module waits for the fence bytes. The block port is asked to
    // freeze on the same event; the rendezvous (u7uh.8) defers the VISUAL
    // freeze until the fence lands, which is the block manager's concern,
    // never the ledger's or the store's.
    kernel.applyFact(
      running('d1', 1, {
        id: 'att-1',
        state: 'completed',
        exitCode: 0,
        fence: FENCE,
        completedAt: '2026-08-08T12:00:02Z',
      }),
    )
    const rec = ledger.recordForAttempt('att-1')
    expect(rec?.status).toBe('success')
    expect(rec?.exitCode).toBe(0)
    expect(persist).toHaveBeenCalledTimes(1)
    // The freeze port call is the LAST projection on the event — after the
    // status and the history write, never before them.
    expect(blocks.events).toEqual(['freeze:att-1:0'])
  })

  it('lane loss abandons the bound projections — unknown, never success, nothing persisted', () => {
    const { kernel, ledger, blocks, persist } = makeEnv()
    ledger.open('make', '/', '', () => undefined)
    kernel.applyFact(promptReady())
    kernel.applyFact(running('d1', 1, { id: 'att-1' }))
    kernel.applyFact(lostF())
    const rec = ledger.recordForAttempt('att-1')
    expect(rec?.status).toBe('unknown')
    expect(rec?.exitCode).toBeNull()
    expect(persist).not.toHaveBeenCalled()
    expect(blocks.events).toEqual(['bind:att-1', 'abandon:att-1'])
  })

  it('the kernel exposes its attempts read-only — the projection lookup after loss', () => {
    const { kernel } = makeEnv()
    kernel.applyFact(promptReady())
    kernel.applyFact(running('d1', 1, { id: 'att-1' }))
    kernel.applyFact(lostF())
    const abandoned = kernel.attempt('att-1')
    expect(abandoned).not.toBeUndefined()
    expect(abandoned?.state).toBe('unknown')
    expect(kernel.attempt('nope')).toBeUndefined()
  })
})

function nativeFact(): LifecycleChanged {
  return { lane: LANE, lifecycle: 'native' }
}
