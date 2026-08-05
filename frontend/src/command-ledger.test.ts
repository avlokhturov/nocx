// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { CommandLedger, type CommandRecord, type CommandStatus } from './command-ledger'

// Fake lineOf that returns the number we feed it. The ledger never caches
// the result, so tests call this through the ledger's own API.
function fakeLineOf(n: number): () => number | undefined {
  const disposed = false
  const fn = () => (disposed ? undefined : n)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return Object.defineProperty(fn, 'disposed', {
    get() {
      return disposed
    },
  }) as unknown as () => number | undefined
}

// Deterministic clock.
function fixtureNow(ms: number): () => number {
  return () => ms
}

describe('CommandLedger', () => {
  let ledger: CommandLedger
  let now: () => number

  beforeEach(() => {
    now = fixtureNow(1000)
    ledger = new CommandLedger({ now })
  })

  // ── open ──────────────────────────────────────────────────────────────

  it('open creates a pending record with status unknown', () => {
    const rec = ledger.open('echo hi', '/home', '', fakeLineOf(5))
    expect(rec.command).toBe('echo hi')
    expect(rec.cwd).toBe('/home')
    expect(rec.host).toBe('')
    expect(rec.status).toBe('unknown')
    expect(rec.exitCode).toBeNull()
    expect(rec.trusted).toBe(false)
    expect(rec.startedAt).toBeNull()
    expect(rec.endedAt).toBeNull()
    expect(rec.lineOf()).toBe(5)
    expect(rec.disposed).toBe(false)
  })

  it('open assigns incrementing ids', () => {
    const r1 = ledger.open('a', '/', '', fakeLineOf(0))
    const r2 = ledger.open('b', '/', '', fakeLineOf(1))
    expect(r1.id).toBeLessThan(r2.id)
  })

  it('open records appear in records() newest last', () => {
    ledger.open('cmd1', '/', '', fakeLineOf(0))
    ledger.open('cmd2', '/', '', fakeLineOf(1))
    const recs = ledger.records()
    expect(recs).toHaveLength(2)
    expect(recs[0].command).toBe('cmd1')
    expect(recs[1].command).toBe('cmd2')
  })

  it('dispose marks the record disposed', () => {
    const rec = ledger.open('x', '/', '', fakeLineOf(0))
    expect(rec.disposed).toBe(false)
    ledger.dispose(rec.id)
    expect(rec.disposed).toBe(true)
  })

  it('dispose is idempotent', () => {
    const rec = ledger.open('x', '/', '', fakeLineOf(0))
    ledger.dispose(rec.id)
    ledger.dispose(rec.id)
    expect(rec.disposed).toBe(true)
  })

  it('open fails with empty command', () => {
    expect(() => ledger.open('', '/', '', fakeLineOf(0))).toThrow()
  })

  // ── clean cycle: A→B→C→D (success) ───────────────────────────────────

  it('clean A→B marks record as pending (not running yet)', () => {
    const l = new CommandLedger({ now: fixtureNow(100) })
    l.open('ls', '/', '', fakeLineOf(3))
    l.onMarker('A')
    expect(l.records()[0].status).toBe('unknown')
    l.onMarker('B')
    expect(l.records()[0].status).toBe('unknown') // still not running
  })

  it('clean A→B→C transitions to running, sets startedAt, trusted=true', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    l.open('ls', '/', '', fakeLineOf(3))
    l.onMarker('A')
    l.onMarker('B')
    // Need the C to actually transition the OPEN record to running.
    // The model: on open, we have a pending record at status 'unknown'.
    // A sets our internal state to prompt-ready; B confirms ownership; C starts
    // the pending record running.
    l.onMarker('C')
    const rec = l.records()[0]
    expect(rec.status).toBe('running')
    expect(rec.startedAt).toBe(500)
    expect(rec.trusted).toBe(true)
  })

  it('C→D with exit 0 → success', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    l.open('ls', '/', '', fakeLineOf(3))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    // endedAt = fixtureNow(500) since we don't mutate the clock mid-test.
    l.onMarker('D', 0)
    const rec = l.records()[0]
    expect(rec.status).toBe('success')
    expect(rec.exitCode).toBe(0)
    expect(rec.endedAt).toBe(500)
    expect(rec.trusted).toBe(true)
  })

  it('C→D with exit 1 → failure', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    l.open('cmd', '/', '', fakeLineOf(3))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D', 1)
    const rec = l.records()[0]
    expect(rec.status).toBe('failure')
    expect(rec.exitCode).toBe(1)
    expect(rec.endedAt).toBe(500)
  })

  it('C→D with exit 127 (command not found) → failure', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    l.open('bogus', '/', '', fakeLineOf(3))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D', 127)
    expect(l.records()[0].status).toBe('failure')
  })

  // ── orphan / untrusted paths ──────────────────────────────────────────

  it('orphan C (no preceding A→B) transitions to running but untrusted', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    l.open('cmd', '/', '', fakeLineOf(0))
    // No A or B — just a C marker.
    l.onMarker('C')
    const rec = l.records()[0]
    expect(rec.status).toBe('running')
    expect(rec.trusted).toBe(false)
  })

  it('orphan D (no preceding C) is ignored for status', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    l.open('cmd', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    // No C — D comes from e.g. empty Enter.
    l.onMarker('D', 0)
    expect(l.records()[0].status).toBe('unknown')
  })

  it('D with exit!=0 on an untrusted run → failure + untrusted', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    l.open('cmd', '/', '', fakeLineOf(0))
    l.onMarker('C') // orphan — untrusted
    l.onMarker('D', 1)
    expect(l.records()[0].status).toBe('failure')
    expect(l.records()[0].trusted).toBe(false)
  })

  // ── interruption ──────────────────────────────────────────────────────

  it('A interrupting a running trusted command → previous is interrupted', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    // Start first command
    const rec1 = l.open('cmd1', '/', '', fakeLineOf(5))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    expect(rec1.status).toBe('running')
    expect(rec1.trusted).toBe(true)

    // A interrupts — starts a new prompt before D arrived
    l.onMarker('A')
    expect(rec1.status).toBe('interrupted')
    expect(rec1.trusted).toBe(true)

    // A second command can start normally
    const rec2 = l.open('cmd2', '/', '', fakeLineOf(10))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    expect(rec2.status).toBe('running')
  })

  it('A interrupting an untrusted running command → previous is unknown', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    const rec = l.open('cmd', '/', '', fakeLineOf(0))
    l.onMarker('C') // orphan → untrusted running
    l.onMarker('A') // interrupt
    expect(rec.status).toBe('unknown')
    expect(rec.trusted).toBe(false)
  })

  // ── D completes the most-recently-opened running record ─────────────

  it('D finishes the most recent running record', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    const r1 = l.open('cmd1', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D', 0) // finishes r1
    expect(r1.status).toBe('success')

    const r2 = l.open('cmd2', '/', '', fakeLineOf(10))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D', 1)
    expect(r2.status).toBe('failure')
    expect(r1.status).toBe('success') // unchanged
  })

  // ── edge cases ────────────────────────────────────────────────────────

  it('B,B from RAW does not grant trust (mirrors input-state.ts)', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    l.open('cmd', '/', '', fakeLineOf(0))
    l.onMarker('B') // no A
    l.onMarker('C')
    expect(l.records()[0].trusted).toBe(false)
  })

  it('records() returns a defensive copy', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    l.open('cmd', '/', '', fakeLineOf(0))
    const r1 = l.records()
    const r2 = l.records()
    expect(r1).not.toBe(r2) // different array references
    expect(r1[0]).toBe(r2[0]) // but same record object references
  })

  it('starts with empty records', () => {
    expect(ledger.records()).toHaveLength(0)
  })

  it('A before any open is a no-op', () => {
    // Should not throw.
    expect(() => ledger.onMarker('A')).not.toThrow()
    expect(ledger.records()).toHaveLength(0)
  })

  it('resolveID returns undefined for unknown id', () => {
    expect(ledger.resolveID(999)).toBeUndefined()
  })

  // ── L1: D with no exit code → unknown ────────────────────────────────

  it('D with no exit code and no prior exitCode → status unknown', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    l.open('cmd', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D') // no exitCode at all
    const rec = l.records()[0]
    expect(rec.status).toBe('unknown')
    expect(rec.exitCode).toBeNull()
  })

  // ── L2: open() while record running → finalizes old record ───────────

  it('open() while a record is running finalizes the old one', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    const r1 = l.open('cmd1', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    expect(r1.status).toBe('running')
    expect(r1.trusted).toBe(true)

    // Open a second command while first is still running (no D arrived).
    const r2 = l.open('cmd2', '/', '', fakeLineOf(10))
    expect(r1.status).toBe('interrupted')
    expect(r1.trusted).toBe(true)
    expect(r2.status).toBe('unknown')
  })

  it('open() while untrusted record running finalizes as unknown', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    const r1 = l.open('cmd1', '/', '', fakeLineOf(0))
    l.onMarker('C') // orphan → untrusted running
    expect(r1.trusted).toBe(false)
    l.open('cmd2', '/', '', fakeLineOf(10))
    expect(r1.status).toBe('unknown')
  })

  // ── B3: finalizeOpen ─────────────────────────────────────────────────

  it('finalizeOpen marks running trusted record as interrupted', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    const rec = l.open('cmd', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    expect(rec.status).toBe('running')
    l.finalizeOpen()
    expect(rec.status).toBe('interrupted')
    expect(rec.endedAt).toBe(500)
  })

  it('finalizeOpen marks running untrusted record as unknown', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    const rec = l.open('cmd', '/', '', fakeLineOf(0))
    l.onMarker('C') // orphan → untrusted
    l.finalizeOpen()
    expect(rec.status).toBe('unknown')
    expect(rec.endedAt).toBe(500)
  })

  it('finalizeOpen is no-op when nothing is running', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    l.open('cmd', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D', 0)
    // Cycle is complete, nothing running.
    expect(() => l.finalizeOpen()).not.toThrow()
  })

  it('stamps wall-clock epoch milliseconds from the injected clock (nocx-rtg0.16)', () => {
    // startedAt/endedAt are persisted, survive a restart, and render as
    // "3 days ago" across sessions — only a wall clock can express that.
    // The backend rejects anything below 2020-01-01 (1577836800000), so a
    // performance.now() clock (milliseconds since page load) would be
    // swept as 1970 the moment the row was written. The ledger must pass
    // the injected clock's epoch values through untouched.
    const epoch = 1_750_000_000_123
    const l = new CommandLedger({ now: fixtureNow(epoch) })
    l.open('ls', '/', '', fakeLineOf(3))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D', 0)
    const rec = l.records()[0]
    expect(rec.startedAt).toBe(epoch)
    expect(rec.endedAt).toBe(epoch)
    expect(rec.startedAt!).toBeGreaterThanOrEqual(1_577_836_800_000)
    expect(rec.endedAt!).toBeGreaterThanOrEqual(1_577_836_800_000)
  })
})

describe('CommandLedger onComplete seam (nocx-rtg0.13)', () => {
  it('emits exactly once when D finalizes a trusted command', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    const rec = l.open('make deploy', '/repo', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D', 0)
    expect(completed).toHaveLength(1)
    expect(completed[0]).toBe(rec)
    expect(completed[0].status).toBe('success')
    expect(completed[0].exitCode).toBe(0)
    expect(completed[0].endedAt).toBe(500)
  })

  it('emits when an A interrupts a running command', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    l.open('sleep 10', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('A') // fresh prompt without D
    expect(completed).toHaveLength(1)
    expect(completed[0].status).toBe('interrupted')
  })

  it('emits when open() interrupts a still-running record (L2)', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    l.open('first', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.open('second', '/', '', fakeLineOf(1))
    expect(completed).toHaveLength(1)
    expect(completed[0].command).toBe('first')
    expect(completed[0].status).toBe('interrupted')
  })

  it('emits when finalizeOpen closes a running command', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    l.open('cmd', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.finalizeOpen()
    expect(completed).toHaveLength(1)
    expect(completed[0].status).toBe('interrupted')
  })

  it('never emits for a record that never started, and never twice for one record', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    const rec = l.open('cmd', '/', '', fakeLineOf(0))
    l.onMarker('D', 0) // D with no running record: ignored
    expect(completed).toHaveLength(0)
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D', 0)
    l.finalizeOpen() // nothing running: no second emit
    expect(completed).toHaveLength(1)
    expect(completed[0]).toBe(rec)
  })

  it('without a callback the ledger still finalizes records (optional seam)', () => {
    const l = new CommandLedger({ now: fixtureNow(500) })
    const rec = l.open('cmd', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D', 0)
    expect(rec.status).toBe('success')
  })
})

describe('CommandLedger environment transitions (N6, nocx-y5v5)', () => {
  // A hand-typed `ssh` that enters a remote environment leaves the running
  // slot WITHOUT completing: it becomes a dormant transition record. The
  // local D — delivered via completeTransition, never as a marker — is the
  // only thing that completes it, exactly once, with the real exit code.

  it('enter() makes the running ssh record a dormant transition record', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    const ssh = l.open('ssh pi@192.168.0.93', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    expect(ssh.status).toBe('running')

    expect(l.enter(ssh.id)).toBe(true)
    // Dormant: open, not running, invisible as a block, no completion.
    expect(ssh.transition).toBe('entered')
    expect(ssh.status).toBe('running') // the ssh process is still alive
    expect(ssh.exitCode).toBeNull()
    expect(ssh.endedAt).toBeNull()
    expect(completed).toHaveLength(0)
    expect(l.transitionRecord).toBe(ssh)

    // The running slot is free: the remote prompt and a remote command can
    // proceed without finalising or destroying the transition.
    l.onMarker('A')
    l.onMarker('B')
    const remote = l.open('pwd', '/home/pi', 'pi@raspberrypi', fakeLineOf(1))
    l.onMarker('C')
    expect(remote.status).toBe('running')
    expect(remote.trusted).toBe(true)
    expect(ssh.endedAt).toBeNull()
    expect(completed).toHaveLength(0)
    expect(l.transitionRecord).toBe(ssh)
  })

  it('several remote commands run to completion while dormant, leaving the transition untouched', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    const ssh = l.open('ssh pi@192.168.0.93', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    expect(l.enter(ssh.id)).toBe(true)

    for (const cmd of ['pwd', 'ls -la', 'git status']) {
      l.onMarker('A')
      l.onMarker('B')
      const r = l.open(cmd, '/home/pi', 'pi@raspberrypi', fakeLineOf(1))
      l.onMarker('C')
      expect(r.status).toBe('running')
      expect(r.trusted).toBe(true)
      l.onMarker('D', 0)
      expect(r.status).toBe('success')
    }

    // The transition record survived every cycle, still dormant.
    expect(ssh.status).toBe('running')
    expect(ssh.transition).toBe('entered')
    expect(ssh.exitCode).toBeNull()
    expect(ssh.endedAt).toBeNull()
    expect(l.transitionRecord).toBe(ssh)
    // Exactly the remote commands completed — the ssh never did.
    expect(completed.map((c) => c.command)).toEqual(['pwd', 'ls -la', 'git status'])
  })

  it('disconnect: the running remote command is cut short with reason transition-lost, the transition takes the local D code', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    const ssh = l.open('ssh pi@192.168.0.93', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.enter(ssh.id)
    l.onMarker('A')
    l.onMarker('B')
    const remote = l.open('top', '/home/pi', 'pi@raspberrypi', fakeLineOf(1))
    l.onMarker('C')
    expect(remote.status).toBe('running')
    expect(remote.trusted).toBe(true)

    const completedTrans = l.completeTransition(255)
    expect(completedTrans).toBe(ssh)
    expect(remote.status).toBe('interrupted')
    expect(remote.reason).toBe('transition-lost')
    expect(remote.exitCode).toBeNull() // the local D never becomes the remote command's code
    expect(remote.endedAt).toBe(500)

    expect(ssh.status).toBe('failure')
    expect(ssh.exitCode).toBe(255)
    expect(ssh.endedAt).toBe(500)
    expect(ssh.transition).toBe('completed')
    expect(l.transitionRecord).toBeNull()

    // Each record completed exactly once: the interrupted command, then the
    // transition. A second completeTransition is a no-op.
    expect(completed.map((c) => c.command)).toEqual(['top', 'ssh pi@192.168.0.93'])
    expect(completed.filter((c) => c === ssh)).toHaveLength(1)
    expect(l.completeTransition(9)).toBeNull()
    expect(completed).toHaveLength(2)
  })

  it('disconnect with an untrusted remote command finalizes it as unknown', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    const ssh = l.open('ssh host', '/', '', fakeLineOf(0))
    l.onMarker('C') // orphan — the ssh command never saw a clean A→B
    l.enter(ssh.id)
    const remote = l.open('cmd', '/', 'host', fakeLineOf(1))
    l.onMarker('C') // orphan — untrusted
    expect(remote.trusted).toBe(false)

    l.completeTransition(255)
    expect(remote.status).toBe('unknown')
    expect(remote.reason).toBe('transition-lost')
    expect(ssh.status).toBe('failure')
    expect(ssh.exitCode).toBe(255)
    expect(completed).toHaveLength(2)
  })

  it('completeTransition stays exactly-once when the interrupted command\u2019s callback reenters', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({
      now: fixtureNow(500),
      onComplete: (r) => {
        completed.push(r)
        // The consumer of the interrupted remote command's completion calls
        // completeTransition again — it must find nothing left to complete.
        l.completeTransition(255)
      },
    })
    const ssh = l.open('ssh host', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.enter(ssh.id)
    l.onMarker('A')
    l.onMarker('B')
    l.open('top', '/', 'host', fakeLineOf(1))
    l.onMarker('C')

    l.completeTransition(255)
    // The transition record reached onComplete exactly once despite the
    // reentrant call inside the remote command's own completion.
    expect(completed.filter((c) => c === ssh)).toHaveLength(1)
    expect(completed.map((c) => c.command)).toEqual(['top', 'ssh host'])
  })

  it('ordinary exit: the exit command completes, then the local D completes the transition as success', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    const ssh = l.open('ssh pi@192.168.0.93', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.enter(ssh.id)
    l.onMarker('A')
    l.onMarker('B')
    const exit = l.open('exit', '/home/pi', 'pi@raspberrypi', fakeLineOf(1))
    l.onMarker('C')
    l.onMarker('D', 0)
    expect(exit.status).toBe('success')

    const completedTrans = l.completeTransition(0)
    expect(completedTrans).toBe(ssh)
    expect(ssh.status).toBe('success')
    expect(ssh.exitCode).toBe(0)
    expect(ssh.transition).toBe('completed')
    expect(completed.map((c) => c.command)).toEqual(['exit', 'ssh pi@192.168.0.93'])
  })

  it('Ctrl-D with no running remote block: the local D completes the transition and nothing else', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    const ssh = l.open('ssh pi@192.168.0.93', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.enter(ssh.id)
    l.onMarker('A')
    l.onMarker('B') // remote prompt, no command running

    const completedTrans = l.completeTransition(0)
    expect(completedTrans).toBe(ssh)
    expect(ssh.status).toBe('success')
    expect(ssh.exitCode).toBe(0)
    expect(ssh.transition).toBe('completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toBe(ssh)
  })

  it('a second ssh from inside is refused: no second dormant record, no nesting', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    const ssh1 = l.open('ssh host1', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    expect(l.enter(ssh1.id)).toBe(true)
    expect(l.enter(ssh1.id)).toBe(false) // a record cannot enter twice

    l.onMarker('A')
    l.onMarker('B')
    const ssh2 = l.open('ssh host2', '/home', 'host1', fakeLineOf(1))
    l.onMarker('C')
    expect(ssh2.status).toBe('running')

    expect(l.enter(ssh2.id)).toBe(false) // refused, not nested
    expect(ssh2.transition).toBeUndefined()
    expect(ssh2.status).toBe('running') // still an ordinary running command
    expect(l.transitionRecord).toBe(ssh1)
    expect(ssh1.transition).toBe('entered')

    // The refused command completes normally; the first transition is intact.
    l.onMarker('D', 0)
    expect(ssh2.status).toBe('success')
    expect(completed.map((c) => c.command)).toEqual(['ssh host2'])
    expect(ssh1.endedAt).toBeNull()
  })

  it('a record that never entered completes as an ordinary command — no transition, no extra completion', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    const ssh = l.open('ssh pi@192.168.0.93', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D', 255) // auth failed — the fail-open path, unchanged
    expect(ssh.status).toBe('failure')
    expect(ssh.exitCode).toBe(255)
    expect(ssh.transition).toBeUndefined()
    expect(completed).toHaveLength(1)
    expect(completed[0]).toBe(ssh)
    // There never was a transition to complete.
    expect(l.completeTransition(255)).toBeNull()
    expect(completed).toHaveLength(1)
  })

  it('completeTransition without a dormant transition is a safe no-op', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    expect(l.transitionRecord).toBeNull()
    expect(l.completeTransition(0)).toBeNull()
    expect(completed).toHaveLength(0)
  })

  it('enter() refuses a finished or unknown record, and a remote D never completes the transition', () => {
    const completed: CommandRecord[] = []
    const l = new CommandLedger({ now: fixtureNow(500), onComplete: (r) => completed.push(r) })
    expect(l.enter(999)).toBe(false) // no such record

    const done = l.open('ls', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.onMarker('D', 0)
    expect(l.enter(done.id)).toBe(false) // already finished

    const ssh = l.open('ssh host', '/', '', fakeLineOf(1))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.enter(ssh.id)
    l.onMarker('A')
    l.onMarker('B')
    const remote = l.open('pwd', '/', 'host', fakeLineOf(2))
    l.onMarker('C')
    l.onMarker('D', 0) // a REMOTE D closes the remote command only
    expect(remote.status).toBe('success')
    expect(ssh.transition).toBe('entered')
    expect(ssh.endedAt).toBeNull()
    expect(l.transitionRecord).toBe(ssh)
  })

  it('entered is a lifecycle state, never a CommandStatus (compile-time proof)', () => {
    // The dormant record's status stays a real CommandStatus ('running' — the
    // ssh process is alive until the local D), and the lifecycle flag is a
    // separate type. The @ts-expect-error is the compile-time proof; tsc
    // enforces it in the type gate. 'entered' must never reach persisted
    // history, whose CommandStatus enum lives in contracts/history.query.schema.json.
    const l = new CommandLedger({ now: fixtureNow(500) })
    const rec = l.open('ssh host', '/', '', fakeLineOf(0))
    l.onMarker('A')
    l.onMarker('B')
    l.onMarker('C')
    l.enter(rec.id)
    const s: CommandStatus = rec.status // still a CommandStatus while entered
    expect(s).toBe('running')
    // @ts-expect-error TransitionLifecycle is not a CommandStatus
    const t: CommandStatus = rec.transition
    void t
  })
})
