import { describe, it, expect } from 'vitest'
import { uuidv7, isUuidv7, timestampOf } from './uuid7'

// The minter the layout wire made necessary (nocx-isoph.4, §7). Every
// assertion here is one the BACKEND makes on the way in — the version, the
// variant, the canonical form — plus the two properties the version was
// chosen for: the timestamp is real, and ids sort in mint order.

describe('uuidv7', () => {
  it('mints what the wire validates: version 7 and the RFC 4122 variant', () => {
    for (let i = 0; i < 200; i++) {
      const id = uuidv7()
      expect(id).toHaveLength(36)
      // The exact shape the Go validator checks, character for character.
      expect(id[14]).toBe('7')
      expect(['8', '9', 'a', 'b']).toContain(id[19])
      expect(isUuidv7(id)).toBe(true)
    }
  })

  it('refuses to accept what crypto.randomUUID produces, which is why it exists', () => {
    // The platform's own minter is a v4. This is the defect nocx-isoph.2
    // handed forward: every id the renderer minted was refused by the
    // methods it has to call.
    const v4 = crypto.randomUUID()
    expect(v4[14]).toBe('4')
    expect(isUuidv7(v4)).toBe(false)
  })

  it('carries the current time in its first 48 bits', () => {
    const before = Date.now()
    const id = uuidv7()
    const after = Date.now()
    const stamp = timestampOf(id)
    expect(stamp).toBeGreaterThanOrEqual(before)
    expect(stamp).toBeLessThanOrEqual(after)
  })

  it('sorts in mint order as plain strings, including inside one millisecond', () => {
    // A frozen clock is the case that matters: a tab and its first pane are
    // minted in the same frame, and "the timestamp prefix is what makes the
    // id sortable" is worth nothing if two ids from one tick sort
    // arbitrarily.
    const frozen = () => 1_750_000_000_000
    const ids = Array.from({ length: 500 }, () => uuidv7(frozen))
    const sorted = [...ids].sort()
    expect(sorted).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never goes backwards when the clock does', () => {
    // An NTP step or a resumed laptop moves Date.now() back. An id is a key,
    // and a key that moves backwards breaks the ordering the version exists
    // for — so a later mint is never a smaller string.
    let t = 1_750_000_000_000
    const clock = () => t
    const first = uuidv7(clock)
    t -= 5_000
    const afterTheStep = uuidv7(clock)
    expect(afterTheStep > first).toBe(true)
  })

  it('mints distinct ids across many calls', () => {
    const ids = new Set(Array.from({ length: 5_000 }, () => uuidv7()))
    expect(ids.size).toBe(5_000)
  })
})
