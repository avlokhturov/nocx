// Negative fixture for Rule 9 direction 1 (ADR-0024 §1): a renderer module
// importing lifecycle/authority state. Deliberately broken — linted only by
// src/eslint-fixture-gate.test.ts (which reads this file's source and runs it
// through the shared lifecycleBoundaryBlocks fragment with a src/renderers/
// filename), and excluded from the normal lint, typecheck and prettier runs.
//
// Every import below must be reported as no-restricted-imports: the first two
// are today's authority modules, the last three are the lifecycle state the
// ADR commits us to (src/lifecycle/).
import { CommandLedger } from '../command-ledger'
import { recordCommand } from '../history-client'
import { shouldShowEditor } from '../lifecycle/state'
import { activateDomain } from '../lifecycle/domains'
import { LifecycleKernel } from '../lifecycle/state'

export function fixtureRenderer(): void {
  void CommandLedger
  void recordCommand
  void shouldShowEditor
  void activateDomain
  void LifecycleKernel
}
