// Command ledger (ADR-0008) — SEVERED by ADR-0024. The marker cycle
// (onMarker), the `trusted` boolean and the N6 environment-transition
// machinery are deleted: no OSC 133 kind may populate or complete a record,
// assign an exit status or persist history. These tests pin the app-owned
// half — open at submit with its start time (ADR-0024 §5), records, dispose,
// resolveID — and the absence of every stream entry point.
import { describe, it, expect, beforeEach } from 'vitest'
import { CommandLedger } from './command-ledger'

// Fake lineOf that returns the number we feed it. The ledger never caches
// the result, so tests call this through the ledger's own API.
const fakeLineOf = (val: number) => () => val

describe('CommandLedger (severed)', () => {
  let ledger: CommandLedger
  beforeEach(() => {
    ledger = new CommandLedger({ now: () => 500 })
  })

  it('starts with no records', () => {
    expect(ledger.records()).toEqual([])
  })

  it('open creates a running record stamped with the app-owned start time', () => {
    const rec = ledger.open('ls', '/', '', fakeLineOf(3))
    expect(rec.id).toBe(1)
    expect(rec.command).toBe('ls')
    expect(rec.cwd).toBe('/')
    expect(rec.host).toBe('')
    // ADR-0024 §5: the app-owned submit is the attempt start — it exists
    // before any bytes that could cause the shell's own start event.
    expect(rec.status).toBe('running')
    expect(rec.startedAt).toBe(500)
    expect(rec.endedAt).toBeNull()
    expect(rec.exitCode).toBeNull()
    expect(rec.disposed).toBe(false)
  })

  it('open assigns incrementing ids', () => {
    expect(ledger.open('a', '/', '', fakeLineOf(1)).id).toBe(1)
    expect(ledger.open('b', '/', '', fakeLineOf(2)).id).toBe(2)
  })

  it('open fails with an empty command', () => {
    expect(() => ledger.open('', '/', '', fakeLineOf(1))).toThrow('command must not be empty')
  })

  it('records() returns all records oldest first, defensively copied', () => {
    ledger.open('first', '/a', '', fakeLineOf(1))
    ledger.open('second', '/b', '', fakeLineOf(2))
    const records = ledger.records()
    expect(records.map((r) => r.command)).toEqual(['first', 'second'])
    expect(records).not.toBe(ledger.records())
    expect(records).toEqual(ledger.records())
  })

  it('dispose marks a record disposed, idempotently', () => {
    const rec = ledger.open('ls', '/', '', fakeLineOf(1))
    expect(rec.disposed).toBe(false)
    ledger.dispose(rec.id)
    expect(rec.disposed).toBe(true)
    ledger.dispose(rec.id) // no throw
    expect(rec.disposed).toBe(true)
  })

  it('dispose of an unknown id is a no-op', () => {
    ledger.dispose(99)
    expect(ledger.records()).toEqual([])
  })

  it('resolveID finds the record or returns undefined', () => {
    const rec = ledger.open('ls', '/', '', fakeLineOf(1))
    expect(ledger.resolveID(rec.id)).toBe(rec)
    expect(ledger.resolveID(999)).toBeUndefined()
  })
  it('has no stream entry point — markers, transitions and trust are gone (compile-time)', () => {
    const rec = ledger.open('ls', '/', '', fakeLineOf(1))
    // The severed surface is proven by the type system, never by calling it
    // — these lines must fail to compile, so they live in a function that is
    const proveAbsent = () => {
      // @ts-expect-error ADR-0024 consequences: onMarker is deleted.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      ledger.onMarker('A')
      // @ts-expect-error ADR-0024 consequences: completeTransition is
      // deleted with the environment-transition machinery.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      ledger.completeTransition(0)
      // @ts-expect-error ADR-0024 consequences: the trusted boolean is
      // deleted.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      rec.trusted
    }
    void proveAbsent
    expect(ledger.records()).toHaveLength(1)
  })
})
