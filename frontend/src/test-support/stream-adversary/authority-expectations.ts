// The intended post-ADR-0024 verdicts for the corpus cases that are the live
// vulnerability today. Inert data: nothing here is asserted against the
// session yet, because today most of these expectations FAIL (that is the
// defect). When the lifecycle lands (epic nocx-u7uh), flip the flag in
// conformance.test.ts (ASSERT_AUTHORITY = true) and each entry here becomes
// the assertion for its case.
//
// Each entry is still machine-checked for coverage: the conformance test
// asserts every HOSTILE_CORPUS case has exactly one expectation and that no
// expectation names an unknown case. One passive case — tagged-A-B — carries
// a verdict too, because the tagged-marker laundering is the attack class the
// ADR names first; that entry is deliberate, not an oversight.
import type { SessionProjection } from './session'

export interface AuthorityExpectation {
  caseId: string
  /** The post-ADR value of each projection named; absent keys are not judged. */
  expects: Partial<SessionProjection>
  /** The bead that severs the authority edge this case probes. */
  bead: string
  note: string
}

const BEAD = 'nocx-u7uh' // ADR-0024 renderer work; exact child bead ids TBD

export const AUTHORITY_EXPECTATIONS: AuthorityExpectation[] = [
  {
    caseId: 'tagged-A-B',
    expects: {
      // A nocx_env tag on OSC 133 authenticates nothing: the bytes are still
      // on the tty (ADR-0024 §2). The keyboard must stay raw and no domain
      // may appear.
      keyboardRoute: 'raw',
      lifecycle: 'Native',
      activeDomain: null,
      historyCalls: 0,
      rewriteAuthority: false,
    },
    bead: BEAD,
    note: 'The tagged marker cycle currently grants ownership exactly like an untagged one; under the ADR the tag is render metadata only.',
  },
  {
    caseId: 'hostile-C-D0-A-B-B-mid-command',
    expects: {
      // The full hostile cycle must leave the running attempt untouched:
      // no forged completion, no exit status, no ownership, no history.
      keyboardRoute: 'raw',
      historyCalls: 0,
      rewriteAuthority: false,
      rerunAuthority: false,
    },
    bead: BEAD,
    note: 'A stream C/D/A/B/B must not complete, freeze or persist anything; the attempt stays open until an authenticated same-domain completion (ADR-0024 §5).',
  },
  {
    caseId: 'hostile-at-suppressed-prompt',
    expects: {
      // At a suppressed prompt the same cycle is the phishing primitive
      // (ADR-0024 §9): nothing stream-derived may take the keyboard.
      keyboardRoute: 'raw',
      historyCalls: 0,
      rewriteAuthority: false,
      rerunAuthority: false,
    },
    bead: BEAD,
    note: 'Suppression is only legal past ACCEPT for a live domain; a stream cycle at a suppressed prompt must never grant ownership.',
  },
]
