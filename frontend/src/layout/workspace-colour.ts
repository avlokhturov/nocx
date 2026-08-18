// What a folded workspace says about the panes nobody can see.
//
// THE COLOUR THAT USED TO LIVE HERE IS GONE (nocx-2mipw). It was derived by
// hashing the workspace id over the four theme accents, because the chain
// stored no colour. The chain stores one now — the user picks it, and the
// palette is `workspace-colours.ts` — so a derived colour would be a second
// answer to a question that has an owner, which is the one thing AD-8 as a
// working habit forbids.

import type { AgentStatus } from '../agent-status'
/** What a collapsed workspace says about the panes nobody can see.
 *
 *  THIS IS THE POINT OF COLLAPSING AT ALL. In a browser a collapsed group is
 *  inert — it holds pages, and a page does nothing while you are not looking
 *  at it. Here it may hold three agents, one of which has just failed, and
 *  hiding it would be hiding the only notice you were going to get. So the
 *  pill reports the state of its members rather than merely counting them,
 *  and folding a workspace away stops costing anything.
 *
 *  Ordered by urgency, and read that way: 'alert' wins over 'busy' wins over
 *  'quiet', because one pane wanting a human is the fact worth surfacing even
 *  when nine others are calm. */
export type GroupAttention = 'quiet' | 'busy' | 'alert'

export interface GroupMemberState {
  readonly hasActivity: boolean
  readonly agentStatus: AgentStatus | null
  readonly warning: boolean
}

/**
 * Fold a group's members into the one thing its pill can say.
 *
 * `idle` IS THE ALERT, AND `working` IS NOT — which reads backwards until you
 * see what agent-status.ts actually detects. 'working' is a spinner frame: the
 * agent is busy and wants nothing. 'idle' is Claude's ✳, which it shows when
 * it has stopped and is WAITING ON YOU. So the state that should pull a person
 * across the strip is the idle one, and the busy one is exactly what they can
 * safely leave folded away.
 */
export function groupAttention(members: readonly GroupMemberState[]): GroupAttention {
  let busy = false
  for (const m of members) {
    // A warning is the environment saying something is wrong; an idle agent is
    // the agent saying the same. Both mean a human is needed here, which is
    // the only state worth pulling someone out of another workspace for.
    if (m.warning || m.agentStatus === 'idle') return 'alert'
    if (m.hasActivity || m.agentStatus === 'working') busy = true
  }
  return busy ? 'busy' : 'quiet'
}
