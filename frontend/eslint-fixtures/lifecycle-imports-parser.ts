// Negative fixture for Rule 9 direction 2 (ADR-0024 §1): a lifecycle module
// importing the OSC parsing surface. Deliberately broken — linted only by
// src/eslint-fixture-gate.test.ts (which reads this file's source and runs it
// through the shared lifecycleBoundaryBlocks fragment with a src/lifecycle/
// filename), and excluded from the normal lint, typecheck and prettier runs.
//
// Every import below must be reported as no-restricted-imports: CommandMarker
// and the OSC 133 parser are rendering facts, and the OSC 636 passport parser
// is tty bytes — a lifecycle module reading any of them can mint authority
// out of the stream.
import type { CommandMarker } from '../renderers/types'
import { parseOsc133 } from '../renderers/xterm'
import { parseOsc636Passport } from '../environment-passport'

export function fixtureLifecycle(): void {
  void parseOsc133
  void parseOsc636Passport
}

export type FixtureMarker = CommandMarker
