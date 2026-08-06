// Environment readiness passport (OSC 636 ; P) — spec
// 2026-08-05-nocxify §5.2. The parser and tracker share their golden
// sequences with the Go exec tests via test-support/passport-fixtures.json,
// which lives on this side because the vitest gate runs in a container that
// mounts frontend/ alone while the Go gate mounts the whole repo. So
// the two sides cannot drift: what the shells emit is exactly what the
// parser accepts here. The fixture is read through fs rather than imported,
// because vite would inline a copy at build time and the Go exec test reads
// the same bytes from disk.
// The project tsconfig ships no @types/node, but vitest runs in node where
// these builtins exist. The imports are used only to read the shared golden
// fixture from the Go package, and every call through them is an untyped
// value — so no-unsafe-* is disabled at the file level, the way
// theme-catalogue.test.ts does for the same reason.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  EnvironmentPassportTracker,
  parseOsc636Passport,
  PASSPORT_PROTOCOL_VERSION,
  type EnvironmentPassport,
} from './environment-passport'

interface FixturePassport {
  sequence: string
  expected: EnvironmentPassport
}

interface PassportFixture {
  protocolVersion: string
  scriptVersion: string
  environmentId: string
  parentEnvironmentId: string
  generation: string
  passports: { enhanced: FixturePassport; minimal: FixturePassport }
  markers: Record<
    string,
    { sequence: string; expected: { kind: string; exitCode?: number; nocxEnv?: string } }
  >
  invalid: {
    passports: Array<{ name: string; sequence: string; reason: string }>
    markers: Array<{ name: string; sequence: string }>
    environmentIds: Array<{ name: string; value: string }>
  }
}

const fixtures: PassportFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./test-support/passport-fixtures.json', import.meta.url)),
    'utf8',
  ),
) as PassportFixture

// payloadOf strips the OSC framing (ESC ] <ident>; … BEL) the shells emit,
// leaving the payload the VT parser hands to the OSC 636 handler — the
// numeric ident is consumed by xterm's parser, not delivered.
function payloadOf(seq: string): string {
  let p = seq
  if (p.startsWith('\x1b]')) p = p.slice(2)
  const semi = p.indexOf(';')
  if (semi > 0) p = p.slice(semi + 1)
  if (p.endsWith('\x07')) p = p.slice(0, -1)
  else if (p.endsWith('\x1b\\')) p = p.slice(0, -2)
  return p
}

describe('parseOsc636Passport', () => {
  it('parses the enhanced passport fixture into a typed value with every field', () => {
    const r = parseOsc636Passport(payloadOf(fixtures.passports.enhanced.sequence))
    expect(r).toEqual({ ok: true, passport: fixtures.passports.enhanced.expected })
  })

  it('parses the minimal-tier passport fixture', () => {
    const r = parseOsc636Passport(payloadOf(fixtures.passports.minimal.sequence))
    expect(r).toEqual({ ok: true, passport: fixtures.passports.minimal.expected })
  })

  it('rejects every invalid passport fixture with its declared reason', () => {
    for (const c of fixtures.invalid.passports) {
      const r = parseOsc636Passport(payloadOf(c.sequence))
      expect(r, c.name).toEqual({ ok: false, reason: c.reason })
    }
  })

  it('rejects a sequence longer than the 512-byte bound as overlong', () => {
    const big = 'P;1;' + 'a'.repeat(500) + ';-;11;enhanced;-'
    expect(big.length).toBeGreaterThan(504)
    expect(parseOsc636Passport(big)).toEqual({ ok: false, reason: 'overlong' })
  })

  it('accepts the "blocks" tier value', () => {
    const r = parseOsc636Passport('P;1;env-ab12;-;11;blocks;-')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.passport.tier).toBe('blocks')
  })
})

describe('EnvironmentPassportTracker', () => {
  const expected = fixtures.passports.enhanced.expected
  const payload = payloadOf(fixtures.passports.enhanced.sequence)

  it('accepts a passport whose id is the expected one', () => {
    const t = new EnvironmentPassportTracker()
    t.setExpectedEnvironmentId('env-ab12')
    expect(t.ingest(payload)).toEqual({ status: 'accepted', passport: expected })
  })

  it('ignores a passport when no id is expected yet', () => {
    const t = new EnvironmentPassportTracker()
    expect(t.ingest(payload)).toEqual({ status: 'ignored', reason: 'no-expected-id' })
  })

  it('reports a passport for a different id as unexpected, never accepted', () => {
    const t = new EnvironmentPassportTracker()
    t.setExpectedEnvironmentId('env-other')
    expect(t.ingest(payload)).toEqual({ status: 'unexpected', passport: expected })
  })

  it('ignores a duplicate passport for an already-accepted id', () => {
    const t = new EnvironmentPassportTracker()
    t.setExpectedEnvironmentId('env-ab12')
    expect(t.ingest(payload).status).toBe('accepted')
    const second = t.ingest(payload)
    expect(second).toEqual({ status: 'duplicate', passport: expected })
  })

  it('a duplicate passport never re-accepts and never re-notifies as accepted', () => {
    const t = new EnvironmentPassportTracker()
    t.setExpectedEnvironmentId('env-ab12')
    const seen: string[] = []
    t.subscribe((d) => seen.push(d.status))
    t.ingest(payload)
    t.ingest(payload)
    expect(seen).toEqual(['accepted', 'duplicate'])
  })

  it('a malformed passport is ignored with its reason and notifies nobody as valid', () => {
    const t = new EnvironmentPassportTracker()
    t.setExpectedEnvironmentId('env-ab12')
    const seen: string[] = []
    t.subscribe((d) => seen.push(d.status))
    const r = t.ingest('P;1;bad id!;-;11;enhanced;-')
    expect(r).toEqual({ status: 'ignored', reason: 'malformed' })
    expect(seen).toEqual(['ignored'])
  })

  it('a non-passport payload on the 636 channel is ignored without notifying', () => {
    const t = new EnvironmentPassportTracker()
    t.setExpectedEnvironmentId('env-ab12')
    const seen: string[] = []
    t.subscribe((d) => seen.push(d.status))
    expect(t.ingest('H;deadbeef')).toEqual({ status: 'ignored', reason: 'not-a-passport' })
    expect(seen).toEqual([])
  })

  it('setExpectedEnvironmentId for a fresh attempt resets acceptance', () => {
    const t = new EnvironmentPassportTracker()
    t.setExpectedEnvironmentId('env-ab12')
    expect(t.ingest(payload).status).toBe('accepted')
    // A new attempt mints a fresh id; the old accepted set must not carry over.
    t.setExpectedEnvironmentId('env-ab12')
    expect(t.ingest(payload).status).toBe('accepted')
  })

  it('an unknown protocol version is ignored and never accepted', () => {
    const t = new EnvironmentPassportTracker()
    t.setExpectedEnvironmentId('env-ab12')
    const unknown = payloadOf(fixtures.invalid.passports[1].sequence)
    expect(unknown).toContain('P;2;')
    expect(t.ingest(unknown)).toEqual({ status: 'ignored', reason: 'unknown-protocol' })
  })

  it('exposes the protocol version the renderer speaks', () => {
    expect(PASSPORT_PROTOCOL_VERSION).toBe(fixtures.protocolVersion)
  })
})
