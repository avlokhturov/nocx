// Environment readiness passport (OSC 636 ; P) — spec 2026-08-05-nocxify,
// §5.2. A shell announces "I am nocx's integration, in environment <id>, at
// tier <t>"; the renderer believes it only when the id is the one nocx
// minted for the attempt in flight.
//
// This module is parse-and-report only: it exposes the passport and its
// disposition to whoever asks (the environment transition itself is owned
// elsewhere, and the backend stays byte-blind — AD-6). It is the frontend
// half of the shared golden fixture at
// frontend/src/test-support/passport-fixtures.json, which the Go
// exec tests use to assert the shells emit exactly the sequences parsed
// here, so the two sides cannot drift.

export const PASSPORT_PROTOCOL_VERSION = '1'

/** Every passport field is restricted to [A-Za-z0-9._-]{1,64} — no escaping,
 *  because no field may contain a separator. */
export const PASSPORT_VALUE_RE = /^[A-Za-z0-9._-]{1,64}$/

export const PASSPORT_TIERS = ['enhanced', 'blocks', 'minimal'] as const
export type PassportTier = (typeof PASSPORT_TIERS)[number]

// The whole OSC sequence is bounded at 512 bytes: ESC ] 636 ; (6 bytes) +
// payload + ST (2 bytes). A payload longer than this can never fit, so it is
// rejected before any field is read.
export const MAX_PASSPORT_PAYLOAD_LENGTH = 504

export interface EnvironmentPassport {
  protocolVersion: string
  environmentId: string
  parentEnvironmentId: string
  scriptVersion: string
  tier: PassportTier
  generation: string
}

export type PassportParseFailure =
  | 'not-a-passport' // the payload is not an OSC 636 P sequence (e.g. H/S)
  | 'overlong' // the whole sequence would exceed the 512-byte bound
  | 'malformed' // wrong field count or a value outside the charset
  | 'unknown-protocol' // protocolVersion is not the one this renderer speaks

export type PassportParseResult =
  { ok: true; passport: EnvironmentPassport } | { ok: false; reason: PassportParseFailure }

export type PassportDisposition =
  | { status: 'accepted'; passport: EnvironmentPassport }
  | { status: 'duplicate'; passport: EnvironmentPassport }
  | { status: 'unexpected'; passport: EnvironmentPassport }
  | { status: 'ignored'; reason: PassportParseFailure | 'no-expected-id' }

/**
 * Parses an OSC 636 payload (the string between `ESC ] 636 ;` and ST) into a
 * typed passport. Anything over-long, malformed, or carrying an unknown
 * protocol version is rejected with its reason — never guessed at, never
 * partially applied.
 */
export function parseOsc636Passport(payload: string): PassportParseResult {
  if (!payload.startsWith('P;')) return { ok: false, reason: 'not-a-passport' }
  if (payload.length > MAX_PASSPORT_PAYLOAD_LENGTH) return { ok: false, reason: 'overlong' }

  const fields = payload.slice(2).split(';')
  if (fields.length !== 6) return { ok: false, reason: 'malformed' }

  const [protocolVersion, environmentId, parentEnvironmentId, scriptVersion, tier, generation] =
    fields
  if (protocolVersion !== PASSPORT_PROTOCOL_VERSION)
    return { ok: false, reason: 'unknown-protocol' }
  if (
    !PASSPORT_VALUE_RE.test(environmentId) ||
    !PASSPORT_VALUE_RE.test(parentEnvironmentId) ||
    !PASSPORT_VALUE_RE.test(scriptVersion) ||
    !PASSPORT_VALUE_RE.test(generation)
  ) {
    return { ok: false, reason: 'malformed' }
  }
  if (!PASSPORT_TIERS.includes(tier as PassportTier)) return { ok: false, reason: 'malformed' }

  return {
    ok: true,
    passport: {
      protocolVersion,
      environmentId,
      parentEnvironmentId,
      scriptVersion,
      tier: tier as PassportTier,
      generation,
    },
  }
}

/**
 * Tracks the passport state of one tab: the environment id minted for the
 * attempt in flight, and the set of ids already accepted. A passport whose
 * id is not the expected one is reported as `unexpected` (the consumer logs
 * it) and never accepted; a duplicate passport for an already-accepted id is
 * reported as `duplicate` and changes nothing.
 *
 * Subscribers are notified of every disposition EXCEPT `not-a-passport`
 * (an H/S hello or snapshot on the same 636 channel is not an event about
 * passports). A fresh attempt mints a fresh id, so `setExpectedEnvironmentId`
 * resets the accepted set.
 */
export class EnvironmentPassportTracker {
  private expectedId: string | null = null
  private acceptedIds = new Set<string>()
  private subs: Array<(d: PassportDisposition) => void> = []

  setExpectedEnvironmentId(id: string | null): void {
    this.expectedId = id
    this.acceptedIds.clear()
  }

  subscribe(cb: (d: PassportDisposition) => void): () => void {
    this.subs.push(cb)
    return () => {
      const i = this.subs.indexOf(cb)
      if (i >= 0) this.subs.splice(i, 1)
    }
  }

  ingest(payload: string): PassportDisposition {
    const parsed = parseOsc636Passport(payload)
    if (!parsed.ok) {
      if (parsed.reason === 'not-a-passport') {
        return { status: 'ignored', reason: 'not-a-passport' }
      }
      return this.emit({ status: 'ignored', reason: parsed.reason })
    }

    const { passport } = parsed
    if (this.expectedId === null) return this.emit({ status: 'ignored', reason: 'no-expected-id' })
    if (passport.environmentId !== this.expectedId) {
      return this.emit({ status: 'unexpected', passport })
    }
    if (this.acceptedIds.has(passport.environmentId)) {
      return this.emit({ status: 'duplicate', passport })
    }
    this.acceptedIds.add(passport.environmentId)
    return this.emit({ status: 'accepted', passport })
  }

  private emit(d: PassportDisposition): PassportDisposition {
    for (const sub of this.subs) sub(d)
    return d
  }
}
