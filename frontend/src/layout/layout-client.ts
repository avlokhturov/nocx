// LayoutClient — the workspaces.* / tabs.* / panes.* / layout.read seam
// (nocx-isoph.4, design §4.1). One method per wire call, every RESULT a
// generated type: the renderer declares nothing of its own about what comes
// back, because a hand-written type can want a field the wire does not carry.
//
// The PARAMS are hand-written here, as they are in every other client: the
// contracts directory declares results, and the handler refuses what it
// cannot parse. What is worth knowing about them is that every id in them is
// minted HERE and is untrusted THERE (§7) — the backend validates the shape,
// refuses an insert on an id that already means something else, and reads no
// authority out of one.
import type { Dispatcher } from '../dispatcher'
import type { LayoutReadResult } from '../generated/layout.read'
import type { TabsCreateResult } from '../generated/tabs.create'
import type { TabsRenameResult } from '../generated/tabs.rename'
import type { TabsRecolourResult } from '../generated/tabs.recolour'
import type { TabsPinResult } from '../generated/tabs.pin'
import type { TabsReorderResult } from '../generated/tabs.reorder'
import type { TabsCloseResult } from '../generated/tabs.close'
import type { PanesCreateResult } from '../generated/panes.create'
import type { PanesCloseResult } from '../generated/panes.close'

/** The identity a close carries in case it empties the application: the
 *  backend mints the replacement tab, but its ids are DURABLE and therefore
 *  the renderer's to supply (§7). Sent on every close — it is consulted only
 *  when there would otherwise be no tab at all, so a caller that always sends
 *  one is not asking for a tab it will not get. */
export interface Replacement {
  tabId: string
  paneId: string
  cwd: string
}

/** What a pane is opened as. `endpoint` is an ssh fact and is refused on a
 *  local pane — the empty string is a real value meaning the local machine,
 *  so there is nowhere honest to put it. */
export interface PaneFacts {
  id: string
  cwd: string
  kind: 'local' | 'ssh'
  endpoint: string | null
  sizeShare: number
}

/** The subset the store needs, declared so a test can substitute a fake
 *  without a WebSocket. */
export interface LayoutClientLike {
  read(): Promise<LayoutReadResult>
  createTab(tab: {
    id: string
    workspaceId: string
    position: number
    firstPane: PaneFacts
  }): Promise<TabsCreateResult>
  createPane(pane: PaneFacts & { tabId: string }): Promise<PanesCreateResult>
  renameTab(id: string, name: string | null): Promise<TabsRenameResult>
  recolourTab(id: string, colour: string | null): Promise<TabsRecolourResult>
  pinTab(id: string, pinned: boolean): Promise<TabsPinResult>
  reorderTabs(workspaceId: string, ids: readonly string[]): Promise<TabsReorderResult>
  closeTab(id: string, replacement: Replacement): Promise<TabsCloseResult>
  closePane(id: string, replacement: Replacement): Promise<PanesCloseResult>
}

export class LayoutClient implements LayoutClientLike {
  constructor(private dispatcher: Dispatcher) {}

  /** The whole chain in one call — what a reloaded renderer draws itself
   *  from. There is no per-rung list method, deliberately: three reads can
   *  interleave with a write and produce a strip that never existed. */
  read(): Promise<LayoutReadResult> {
    return this.dispatcher.call<LayoutReadResult>('layout.read', {})
  }

  /** Creation is always creation-with-content: a tab arrives with the pane it
   *  was minted around, because a tab with no pane may not exist even for the
   *  length of a statement. */
  createTab(tab: {
    id: string
    workspaceId: string
    position: number
    firstPane: PaneFacts
  }): Promise<TabsCreateResult> {
    return this.dispatcher.call<TabsCreateResult>('tabs.create', {
      id: tab.id,
      workspaceId: tab.workspaceId,
      parentId: null,
      name: null,
      colour: null,
      position: tab.position,
      pinned: false,
      layout: 'row',
      firstPane: tab.firstPane,
    })
  }

  /** The SPLIT: a second pane into a tab that already exists. */
  createPane(pane: PaneFacts & { tabId: string }): Promise<PanesCreateResult> {
    return this.dispatcher.call<PanesCreateResult>('panes.create', pane)
  }

  /** null is the operation, not the absence of one: clearing the name puts
   *  the tab back to the label derived from its panes (§4.5). */
  renameTab(id: string, name: string | null): Promise<TabsRenameResult> {
    return this.dispatcher.call<TabsRenameResult>('tabs.rename', { id, name })
  }

  recolourTab(id: string, colour: string | null): Promise<TabsRecolourResult> {
    return this.dispatcher.call<TabsRecolourResult>('tabs.recolour', { id, colour })
  }

  pinTab(id: string, pinned: boolean): Promise<TabsPinResult> {
    return this.dispatcher.call<TabsPinResult>('tabs.pin', { id, pinned })
  }

  /** The WHOLE strip order for one workspace, never a move of one member:
   *  the backend writes positions 0..n-1 from it and answers with the tabs as
   *  stored, which is the order the strip then draws. */
  reorderTabs(workspaceId: string, ids: readonly string[]): Promise<TabsReorderResult> {
    return this.dispatcher.call<TabsReorderResult>('tabs.reorder', { workspaceId, ids: [...ids] })
  }

  closeTab(id: string, replacement: Replacement): Promise<TabsCloseResult> {
    return this.dispatcher.call<TabsCloseResult>('tabs.close', { id, replacement })
  }

  /** The durable removal, and NOT secrets.paneClosed: that notification tells
   *  the capture registry a scope is over and touches no store, while this
   *  rewrites three tables and can mint a replacement tab. A pane the user
   *  closes needs both, and this is the one that decides what the strip looks
   *  like afterwards. */
  closePane(id: string, replacement: Replacement): Promise<PanesCloseResult> {
    return this.dispatcher.call<PanesCloseResult>('panes.close', { id, replacement })
  }
}
