// Input-ownership state (ADR-0024 §1, §6) — SEVERED. The marker/submit/
// passport events and the trusted/owned booleans are deleted: no sequence
// parsed from the byte stream may grant DOM keyboard ownership or declare
// prompt readiness. The only axis left is the buffer, driven by the xterm
// alt-buffer event — a renderer-owned presentation fact. No test here feeds
// a stream marker, because the machine has no event for one.
import { describe, expect, it } from 'vitest'
import { InputStateController, initialMachine, reduce, type Machine } from './input-state'

describe('input-state: the severed buffer axis (ADR-0024)', () => {
  it('starts Native — a conventional terminal, raw input, no ownership', () => {
    expect(initialMachine()).toEqual({ state: 'Native' })
  })

  it('the alt-buffer event moves the buffer axis, never ownership', () => {
    const alt = reduce(initialMachine(), { type: 'buffer', buffer: 'alternate' })
    expect(alt).toEqual({ state: 'ALT_SCREEN' })
    expect(reduce(alt, { type: 'buffer', buffer: 'normal' })).toEqual({ state: 'Native' })
  })

  it('reset and exit return to Native from any state', () => {
    expect(reduce({ state: 'ALT_SCREEN' }, { type: 'reset' })).toEqual({ state: 'Native' })
    expect(reduce({ state: 'ALT_SCREEN' }, { type: 'exit' })).toEqual({ state: 'Native' })
    expect(reduce(initialMachine(), { type: 'exit' })).toEqual({ state: 'Native' })
  })

  it('a buffer event for the current buffer changes nothing', () => {
    expect(reduce(initialMachine(), { type: 'buffer', buffer: 'normal' })).toEqual({
      state: 'Native',
    })
    expect(reduce({ state: 'ALT_SCREEN' }, { type: 'buffer', buffer: 'alternate' })).toEqual({
      state: 'ALT_SCREEN',
    })
  })

  it('does not mutate its input', () => {
    const m = initialMachine()
    reduce(m, { type: 'buffer', buffer: 'alternate' })
    expect(m).toEqual({ state: 'Native' })
  })
})

describe('InputStateController', () => {
  it('tracks state and fires onChange only on real changes', () => {
    const c = new InputStateController()
    const seen: string[] = []
    c.onChange((m) => seen.push(m.state))
    c.dispatch({ type: 'buffer', buffer: 'alternate' })
    c.dispatch({ type: 'buffer', buffer: 'alternate' }) // no change: no notify
    c.dispatch({ type: 'buffer', buffer: 'normal' })
    expect(seen).toEqual(['ALT_SCREEN', 'Native'])
    expect(c.state).toBe('Native')
  })

  it('has no marker, submit or passport events — the stream cannot reach it', () => {
    const m: Machine = initialMachine()
    // @ts-expect-error ADR-0024 §1: no marker event exists on the machine.
    reduce(m, { type: 'marker', kind: 'A' })
    // @ts-expect-error ADR-0024 §1: no submit event exists on the machine.
    reduce(m, { type: 'submit' })
    // @ts-expect-error ADR-0024 §1: no passport event exists on the machine.
    reduce(m, { type: 'passport' })
    // @ts-expect-error ADR-0024 §6: the trusted boolean is deleted.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    m.trusted
    // @ts-expect-error ADR-0024 §6: the owned boolean is deleted.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    m.owned
  })
})
