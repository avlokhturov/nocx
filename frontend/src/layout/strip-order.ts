// stripOrder — where the strip draws each tab, from two facts the backend
// stores (nocx-isoph.4, design §4.5).
//
// THIS IS A PROJECTION, NOT A DECISION, and the difference is the whole point
// of the bead. The order is `position`, which the backend writes when
// tabs.reorder is called; `pinned` is a flag the backend stores and never
// acts on, because "keeps the tab at the head of the strip" is a statement
// about drawing. So this function reads two stored facts and returns the
// order they imply — it never invents one, never breaks a tie by anything but
// the stored position, and is pure so a test can say what it does.
//
// If the backend ever writes positions when a tab is pinned, this becomes a
// second owner of the order and must go. It is one function so that removing
// it is one deletion.
import type { Tab } from '../generated/layout.read'

/**
 * The tabs of one strip, in drawing order: pinned first, then the rest, each
 * group in stored `position` order.
 *
 * Stable within each group, so pinning a tab does not shuffle its neighbours
 * — the strip is something people navigate by muscle memory, and a reorder
 * nobody asked for is worse than no order at all.
 */
export function stripOrder(tabs: readonly Tab[]): Tab[] {
  const byPosition = [...tabs].sort((a, b) => a.position - b.position)
  return [...byPosition.filter((t) => t.pinned), ...byPosition.filter((t) => !t.pinned)]
}
