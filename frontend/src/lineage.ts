// Lineage in the renderer (nocx-wtv3p, design D6 / §8 items 5 and 6).
//
// A tab records who opened it, by the edge the BACKEND admitted and handed
// back on the open ack (nocx-9hu9d, SessionHandle.parent). This module is the
// single owner of the one question the renderer asks of that edge:
//
//   which live tabs descend from this one?
//
// and of the sentence that names them. Both exist for exactly one purpose —
// so that closing a tab with live descendants ASKS the person rather than
// deciding for them.
//
// WHAT THIS MODULE MAY NEVER BE USED FOR. The edge answers provenance and
// confers nothing (ADR-0020 §5): being someone's child is not permission to
// observe, drive or close, and neither is being someone's parent. A tab
// created by another may since have been taken over, re-credentialed and
// ssh'd into production, and it is that tab's descendant forever. So nothing
// here decides what a tab may do to another tab, and nothing may be built on
// it that does — the backend refuses such an attempt whatever the renderer
// believes (internal/transport/ws_lineage_prohibitions_test.go), and a
// renderer that tried would only be lying to the person in front of it.
//
// The complementary rule the ask exists to keep: a parent's death never
// closes its children — not on process exit, not on a backend restart, not on
// a dropped link. Three of those four are FAILURES, and a failure carries no
// information about whether the work is still wanted. Only an explicit human
// act may close a tab, which is why this module produces a QUESTION and never
// a decision.

import { nameAtMost } from './live-work'

/** One live tab, as far as lineage is concerned: the session it holds, the
 *  session that opened that one, and what the person calls it. */
export interface LineageNode {
  /** The backend session this tab holds. */
  readonly sessionId: string
  /** The session that opened it, as the backend ADMITTED it, or null for a
   *  tab nobody opened. Never a claim the renderer made. */
  readonly parentSessionId: string | null
  /** The tab's own label, as the person sees it in the strip. */
  readonly label: string
}

/**
 * The live tabs that descend from `sessionId`, at any depth, in breadth-first
 * order — children before grandchildren, so a truncated list names the
 * closest ones.
 *
 * Only tabs that are actually open are considered, because `nodes` is the set
 * of open tabs: a descendant whose tab has already gone is not something a
 * close would leave running, and this question is only ever asked to describe
 * what a close leaves behind.
 *
 * The walk carries a visited set even though the backend refuses to admit a
 * cycle (session.ErrParentCycle). What is walked here is not the registry —
 * it is whatever the open acks have accumulated in this renderer — and a
 * question asked on the close path may not be able to hang the UI, whatever
 * arrives in it.
 */
export function liveDescendants(sessionId: string, nodes: readonly LineageNode[]): LineageNode[] {
  const childrenOf = new Map<string, LineageNode[]>()
  for (const node of nodes) {
    if (node.parentSessionId === null) continue
    const siblings = childrenOf.get(node.parentSessionId)
    if (siblings) siblings.push(node)
    else childrenOf.set(node.parentSessionId, [node])
  }

  const found: LineageNode[] = []
  const seen = new Set<string>([sessionId])
  let frontier = [sessionId]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      for (const child of childrenOf.get(id) ?? []) {
        if (seen.has(child.sessionId)) continue
        seen.add(child.sessionId)
        found.push(child)
        next.push(child.sessionId)
      }
    }
    frontier = next
  }
  return found
}

/**
 * The question put to the person closing a tab that has live descendants. It
 * NAMES them, because "some other tabs" is not something anyone can decide
 * about, and it says what closing does — which is nothing to them.
 *
 * The answer this asks for is only ever about the tab being closed. Offering
 * to close the descendants too would make the parent's end decide theirs,
 * which is the rule this whole module exists to keep (design D6).
 *
 * How many it names before it starts counting is `nameAtMost`'s, shared with
 * the workspace close (live-work.ts): "past five the list becomes a wall" is
 * one rule about a person reading a prompt, not one rule per prompt.
 */
export function leftRunningMessage(descendants: readonly LineageNode[]): string {
  const list = nameAtMost(descendants.map((d) => `“${d.label}”`))
  const subject = descendants.length === 1 ? '1 tab' : `${descendants.length} tabs`
  return `This tab opened ${subject} still running: ${list}. Closing it leaves them running — they are not closed with it.`
}
