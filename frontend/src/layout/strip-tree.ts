// lineageOrder — the vertical strip's tree: workspace → tab → lineage
// children (nocx-isoph.5; workspaces UX design §4.3, tabs/panes design §4.2).
//
// WHAT THIS PROJECTS AND WHAT IT MUST NOT. `parentId` is the LINEAGE edge and
// nothing else — who spawned whom, provenance, immutable (design §4.2). This
// module draws it as indentation and reads no authority out of it: a child is
// under its parent on screen, and that is the entire consequence. It never
// decides membership (the workspace does, and it is a different edge) and
// never decides an order beyond the one stripOrder already gives.
//
// A CHILD WHOSE PARENT IS NOT IN THE SET IS A TOP-LEVEL ROW. Provenance is
// not membership: the parent may be in another workspace, may have been
// closed (the edge goes null then, which is the honest "provenance lost"
// state), or may simply not be drawn. A walk that waited for it would drop
// the row from the strip, and a row the user cannot see is a tab they cannot
// close.
import type { Tab } from '../generated/layout.read'
import { stripOrder } from './strip-order'

/** One row of the tree: the tab, and how far in it is drawn. */
export interface LineageRow {
  readonly tab: Tab
  /** 0 for a top-level row, +1 per generation. Indentation is driven by this
   *  number and never by nested DOM — the same technique the kit's TreeRow
   *  uses, so a row is a row whatever its depth. */
  readonly depth: number
}

/**
 * The tabs of one strip in tree order: each parent immediately followed by
 * its children, siblings in the backend's strip order.
 *
 * Every tab appears exactly once. The backend refuses a cycle in the lineage
 * edge, and this walk survives one anyway — a projection that would hang on a
 * bad row is a projection with a defect waiting for one.
 */
export function lineageOrder(tabs: readonly Tab[]): LineageRow[] {
  const present = new Set(tabs.map((t) => t.id))
  const childrenOf = new Map<string, Tab[]>()
  const roots: Tab[] = []
  for (const tab of tabs) {
    const parent = tab.parentId
    if (parent === null || !present.has(parent) || parent === tab.id) {
      roots.push(tab)
      continue
    }
    const siblings = childrenOf.get(parent)
    if (siblings) siblings.push(tab)
    else childrenOf.set(parent, [tab])
  }

  const rows: LineageRow[] = []
  const drawn = new Set<string>()
  const walk = (tab: Tab, depth: number): void => {
    if (drawn.has(tab.id)) return
    drawn.add(tab.id)
    rows.push({ tab, depth })
    for (const child of stripOrder(childrenOf.get(tab.id) ?? [])) walk(child, depth + 1)
  }
  for (const root of stripOrder(roots)) walk(root, 0)
  // A cycle leaves its members unreachable from any root; they are still
  // tabs, so they are drawn at the top level rather than silently dropped.
  for (const tab of stripOrder(tabs)) walk(tab, 0)
  return rows
}
