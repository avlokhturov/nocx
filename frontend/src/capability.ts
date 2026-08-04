// The integration axis and the observed capability statement (nocx-4t37.2).
//
// The MODEL holds the integration axis the brief named — terminal → nocxify
// → relay, in ascending order of how much of ours runs on the far host.
// relay is present from the start (nocx-if6 phase B) and is NEVER offered in
// the UI: a third value added later becomes a flag threaded through a switch;
// a third value present from the start is a mode with no implementation —
// the same move the tunnel model made carrying all three directions before
// -R and -D existed (nocx-6nh6).
//
// The UI never shows the axis. The owner's second reading was explicit:
// "terminal to nocxify to relay" conflates three independent facts — who
// owns keyboard input, what semantic evidence exists, and whether a helper
// binary is on the far host. Those are correlated today and are not one
// axis, and a three-position selector implies free choice where the state is
// mostly OBSERVED. What the rail shows is a capability statement about what
// is true right now:
//
//   - 'native-input'     — nocx owns no keyboard input and has no semantic
//                          evidence: a plain shell (no markers ever), or the
//                          user latched native input. Enter goes to the far
//                          shell raw and nothing semantic is known about the
//                          result.
//   - 'command-blocks'   — the shell speaks our protocol AND nocx owns the
//                          trusted prompt right now: Enter runs through the
//                          editor and the result becomes a block.
//   - 'enhanced-input'   — the shell speaks our protocol (evidence exists:
//                          cwd, exit codes, blocks from commands already
//                          run) but nocx does not own the prompt at this
//                          moment — a command is running, an alt-screen
//                          program owns the pane, or the prompt is not
//                          trusted.
import type { InputState } from './input-state'

export type Capability = 'native-input' | 'command-blocks' | 'enhanced-input'

export const CAPABILITY_LABELS: Record<Capability, string> = {
  'native-input': 'Native input',
  'command-blocks': 'Command blocks',
  'enhanced-input': 'Enhanced input',
}

/** The model axis. Never rendered; carried so the relay third value exists
 *  from the start instead of being threaded through every switch later. */
export type ShellMode = 'terminal' | 'nocxify' | 'relay'

/** The profile's connection-scope launch policy (auto|ask|off, nocx-p0ug):
 *  the default the tab's capability control starts from. The tab may
 *  override for this session; off refuses even the explicit path. */
export type ShellIntegrationPolicy = 'auto' | 'ask' | 'off'

/** The facts the capability statement is derived from (AD-6): the input
 *  machine's observed state and the session's sticky integration flag — the
 *  seam the brief names, never the byte stream. `native` is the user's own
 *  latch (the native-mode escape), which outranks every observation. */
export interface CapabilityFacts {
  integrated: boolean
  state: InputState
  trusted: boolean
  owned: boolean
  native: boolean
}

export function deriveCapability(f: CapabilityFacts): Capability {
  if (f.native || !f.integrated) return 'native-input'
  if (f.state === 'PROMPT_READY' && f.trusted && f.owned) return 'command-blocks'
  return 'enhanced-input'
}

/** One action the capability popover offers. The action set is derived from
 *  the observed capability + policy — it is never a picker of modes. */
export type CapabilityAction =
  { kind: 'integrate'; label: string; disabledReason?: string } | { kind: 'native'; label: string }
