// @vitest-environment jsdom
// The session seam imports renderers/xterm.ts (the real OSC parsers), which
// pulls @xterm/addon-webgl — a UMD module that needs a browser `self`. The
// existing renderer tests carry the same pragma.
//
// Adversarial conformance — replays the stream corpus against a real
// assembled session and snapshots the security-sensitive projections.
//
// What is asserted: the parser-level invariants (malformed/foreign/private/
// DCS sequences are inert; OSC 7 moves cwd and nothing else; a fence alone
// does nothing), the tracker-level expected-id invariant (a passport cannot
// activate a domain without a minted id), the buffer axis, and — with
// ASSERT_AUTHORITY true — the post-ADR-0024 verdicts for the hostile cycles
// in authority-expectations.ts. The severance (bead nocx-u7uh.1) made the
// stream render-only: the hostile cycles must leave every security-sensitive
// projection byte-identical.
import { describe, expect, it } from 'vitest'
import { CORPUS, HOSTILE_CORPUS } from '../../test-support/stream-adversary/corpus'
import { replayCase } from '../../test-support/stream-adversary/harness'
import { assembleTodaySession } from '../../test-support/stream-adversary/session'
import { AUTHORITY_EXPECTATIONS } from '../../test-support/stream-adversary/authority-expectations'
import type { SessionProjection } from '../../test-support/stream-adversary/session'

/** The severance (nocx-u7uh.1) landed: each hostile case asserts its
 *  authority-expectations entry instead of just replaying it. */
const ASSERT_AUTHORITY = true

const ALL_PROJECTION_KEYS: (keyof SessionProjection)[] = [
  'lifecycle',
  'keyboardRoute',
  'activeDomain',
  'attemptState',
  'blockState',
  'historyCalls',
  'environmentStack',
  'rewriteAuthority',
  'rerunAuthority',
  'cwd',
]

describe('corpus integrity', () => {
  it('has unique case ids', () => {
    const ids = CORPUS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every case a context, frames and a note', () => {
    for (const c of CORPUS) {
      expect(c.context).toBeTruthy()
      expect(c.frames.length).toBeGreaterThan(0)
      expect(c.note.length).toBeGreaterThan(0)
    }
  })

  it('keeps hostile cases in the hostile corpus and expectations covering them', () => {
    const expectationIds = AUTHORITY_EXPECTATIONS.map((e) => e.caseId)
    expect(new Set(expectationIds).size).toBe(expectationIds.length)
    for (const c of HOSTILE_CORPUS) {
      expect(expectationIds).toContain(c.id)
    }
    for (const e of AUTHORITY_EXPECTATIONS) {
      expect(
        CORPUS.some((c) => c.id === e.caseId),
        `expectation for unknown case ${e.caseId}`,
      ).toBe(true)
    }
  })
})

describe('the harness delivers every frame through the session seam', () => {
  it('replays every corpus case and delivers every frame', () => {
    for (const c of CORPUS) {
      const result = replayCase(c, assembleTodaySession)
      expect(result.caseId).toBe(c.id)
      expect(result.framesDelivered).toBe(c.frames.length)
      // Every frame (prelude + adversarial) must leave an observable event:
      // a case that silently stopped reaching the session fails here.
      expect(result.events.length).toBe((c.prelude?.length ?? 0) + c.frames.length)
    }
  })

  it('delivers the hostile cycle as real marker events, not silence', () => {
    const hostile = CORPUS.find((c) => c.id === 'hostile-C-D0-A-B-B-mid-command')
    expect(hostile).toBeDefined()
    const result = replayCase(hostile!, assembleTodaySession)
    // The events log covers prelude + frames; the adversarial section is the
    // last `frames.length` events.
    const markerEvents = result.events.slice(-hostile!.frames.length)
    expect(markerEvents).toEqual(['marker:C', 'marker:D:0', 'marker:A', 'marker:B', 'marker:B'])
  })

  it('snapshots before and after as independent objects with every projection', () => {
    for (const c of CORPUS) {
      const result = replayCase(c, assembleTodaySession)
      expect(result.before).not.toBe(result.after)
      for (const key of ALL_PROJECTION_KEYS) {
        expect(result.before[key], `${c.id}: before.${key}`).toBeDefined()
        expect(result.after[key], `${c.id}: after.${key}`).toBeDefined()
      }
    }
  })
})

describe('parser-level invariants (pass today, must never stop passing)', () => {
  /** Cases whose frames must be entirely inert: the parser rejects them or
   *  they carry no lifecycle grammar at all. bare-C is here now that the
   *  severance made C render-only: an idle C is delivered as a real marker
   *  event (the delivery proof above) and drives nothing. */
  const INERT = [
    'malformed-tag',
    'bad-param',
    'oversized-osc133',
    'private-osc-1337',
    'private-osc-other',
    'dcs-lookalike',
    'fence-no-event',
    'bare-D',
    'bare-C',
  ]

  it.each(INERT)('%s changes no security-sensitive projection', (id) => {
    const result = replayCase(
      CORPUS.find((c) => c.id === id)!,
      assembleTodaySession,
    )
    expect(result.before).toEqual(result.after)
  })

  it('osc7-cwd moves only the cwd projection', () => {
    const result = replayCase(
      CORPUS.find((c) => c.id === 'osc7-cwd')!,
      assembleTodaySession,
    )
    expect(result.after.cwd).toBe('/tmp/hostile')
    expect(result.after).toEqual({ ...result.before, cwd: '/tmp/hostile' })
  })

  it('alt-buffer enter/exit move the buffer axis only (never ownership)', () => {
    const enter = replayCase(
      CORPUS.find((c) => c.id === 'alt-buffer-enter')!,
      assembleTodaySession,
    )
    // The buffer is a separate axis (ADR-0024 §6): entering the alternate
    // buffer changes the buffer projection, never ownership. The lifecycle
    // projection reports the buffer state today; the keyboard stays raw.
    expect(enter.after.lifecycle).toBe('ALT_SCREEN')
    expect(enter.after.keyboardRoute).toBe('raw')
    const exit = replayCase(
      CORPUS.find((c) => c.id === 'alt-buffer-exit')!,
      assembleTodaySession,
    )
    expect(exit.after.lifecycle).toBe('Native')
    expect(exit.after.keyboardRoute).toBe('raw')
  })
})

describe('passport expected-id invariant (a surviving characterization, not authority)', () => {
  it('a passport with no minted id is ignored and accepts nothing', () => {
    const result = replayCase(
      CORPUS.find((c) => c.id === 'passport-no-expected')!,
      assembleTodaySession,
    )
    expect(result.after.environmentStack).toBe('ignored')
    expect(result.after.activeDomain).toBeNull()
  })

  it('a passport for a foreign id is unexpected and never accepted', () => {
    const result = replayCase(
      CORPUS.find((c) => c.id === 'passport-unexpected')!,
      assembleTodaySession,
    )
    expect(result.after.environmentStack).toBe('unexpected')
    expect(result.after.activeDomain).toBeNull()
  })

  it('an overlong passport is rejected by the parser bound', () => {
    const result = replayCase(
      CORPUS.find((c) => c.id === 'passport-overlong')!,
      assembleTodaySession,
    )
    expect(result.after.environmentStack).toBe('ignored')
  })

  it('a matching passport is accepted against the app-minted id', () => {
    const result = replayCase(
      CORPUS.find((c) => c.id === 'passport-enhanced')!,
      assembleTodaySession,
    )
    expect(result.after.activeDomain).toBe('env-ab12')
  })
})
describe('authority expectations (post-ADR verdicts — asserted once ASSERT_AUTHORITY is flipped)', () => {
  it('judges the hostile corpus once ASSERT_AUTHORITY is flipped', () => {
    // This test exists so the assertions are compiled and their expectations
    // are exercised against the corpus — flipped on by editing the constant
    // at the top of this file (the severance flipped it).
    for (const expectation of AUTHORITY_EXPECTATIONS) {
      const case_ = CORPUS.find((c) => c.id === expectation.caseId)!
      const result = replayCase(case_, assembleTodaySession)
      if (ASSERT_AUTHORITY) {
        expect(result.after).toMatchObject(expectation.expects)
      }
    }
    // Prove the expectations name projections the snapshot actually carries.
    for (const expectation of AUTHORITY_EXPECTATIONS) {
      for (const key of Object.keys(expectation.expects) as (keyof SessionProjection)[]) {
        expect(ALL_PROJECTION_KEYS).toContain(key)
      }
    }
  })
})
