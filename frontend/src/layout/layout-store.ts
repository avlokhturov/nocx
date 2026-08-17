// LayoutStore — the renderer's CACHE of a chain it does not own
// (nocx-isoph.4, design §4.1).
//
// THE DISTINCTION THIS FILE EXISTS TO HOLD: a cache is fine, deciding is not.
// Every field here arrived from the backend and is replaced by what the
// backend answers; nothing in this module computes an order, invents a
// membership or resolves a conflict. When a call fails, the cache is left
// exactly as it was — which is why a refused reorder cannot show as a strip
// that moves and then snaps back. The renderer asks and re-renders.
//
// WHAT IS CACHED IS WHAT IS STORED. The label, the activity indicator and the
// attention indicator are not here and must never be: they are computed from
// the panes (§4.5), attention arrives at a PANE, and a copy on the tab would
// give one fact two owners that diverge the first time a pane is dragged.
import type { LayoutReadResult, Tab, Pane, Workspace } from '../generated/layout.read'
import type { LayoutClientLike, PaneFacts, Replacement } from './layout-client'
import { uuidv7 } from './uuid7'

/** An empty chain: what a fresh profile has, and what the store holds before
 *  the first read answers. Never null — the collections are mapped over on
 *  the first draw. */
const EMPTY: LayoutReadResult = {
  // The default workspace's id is the backend's to say (AD-8). Until the
  // first read, the store knows of no workspace at all rather than guessing
  // at the constant, and openTab before load() is a programming error rather
  // than a tab landing somewhere invented.
  defaultWorkspaceId: '',
  workspaces: [],
  tabs: [],
  panes: [],
}

/** What a pane is opened as, minus the id the store mints. */
export interface NewPane {
  kind: 'local' | 'ssh'
  /** The canonical user@host:port for an ssh pane; null for a local one. */
  endpoint: string | null
  /** Where the pane is. Empty means "wherever an unconfigured local shell
   *  starts", which is what the renderer honestly knows at the moment a tab
   *  is opened — the cwd arrives from the session a round trip later, and
   *  there is no method that revises it until restore (nocx-l21ib) needs one. */
  cwd: string
}

/**
 * What openTab minted, and when the backend agreed.
 *
 * The ids come back SYNCHRONOUSLY and the object does not, because those are
 * two different facts: an id is the renderer's to mint (§7 — it is durable,
 * so it cannot come from a backend instance), while the row is the backend's
 * to write. The chrome can therefore be built in the same turn the user
 * pressed the key, and `created` is where a refusal arrives — a create the
 * backend rejects is a pane that must not stay on screen.
 */
export interface OpenedTab {
  tabId: string
  paneId: string
  created: Promise<void>
}

export class LayoutStore {
  private state: LayoutReadResult = EMPTY
  private readonly listeners = new Set<() => void>()

  constructor(private readonly client: LayoutClientLike) {}

  // ── the cache, read ────────────────────────────────────────────────────

  /** Every tab, in the backend's order. */
  tabs(): readonly Tab[] {
    return this.state.tabs
  }

  workspaces(): readonly Workspace[] {
    return this.state.workspaces
  }

  /** The panes of one tab, in the backend's order. A tab is labelled by
   *  these (§4.5), so the strip cannot be drawn without them. */
  panesOf(tabId: string): readonly Pane[] {
    return this.state.panes.filter((p) => p.tabId === tabId)
  }

  tabOf(paneId: string): Tab | undefined {
    const pane = this.state.panes.find((p) => p.id === paneId)
    return pane ? this.state.tabs.find((t) => t.id === pane.tabId) : undefined
  }

  tab(tabId: string): Tab | undefined {
    return this.state.tabs.find((t) => t.id === tabId)
  }

  panes(): readonly Pane[] {
    return this.state.panes
  }

  /** Where a tab goes when nothing else says: the workspace that never
   *  renders. The id is the backend's — read, never spelled out here (§7). */
  defaultWorkspaceId(): string {
    return this.state.defaultWorkspaceId
  }

  /** Notified after every change to the cache, and only after: a listener
   *  that runs on a call that FAILED would be rendering a state that does
   *  not exist. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ── the wire ───────────────────────────────────────────────────────────

  /** Read the whole chain and replace the cache with it. This is the call
   *  that makes a renderer reload cheap: the colours, the names, the order
   *  and the pinning come back because they were never here. */
  async load(): Promise<void> {
    this.state = await this.client.read()
    this.changed()
  }

  /**
   * Open a tab around a new pane, minting both ids as UUIDv7 (§7).
   *
   * The ids are the renderer's because they are DURABLE — a pane's id must
   * survive a restart, so it cannot come from a backend instance — and they
   * are untrusted on the other side for exactly that reason.
   *
   * The answer, not the request, is what lands in the cache: a create reads
   * back what the store holds, including the containers it filled in.
   */
  openTab(pane: NewPane): OpenedTab {
    const tabId = uuidv7()
    const paneId = uuidv7()
    const workspaceId = this.state.defaultWorkspaceId
    if (workspaceId === '') {
      throw new Error('layout: openTab before the first read; the workspace is the backend to name')
    }
    const created = this.client
      .createTab({
        id: tabId,
        workspaceId,
        position: this.state.tabs.length,
        firstPane: paneFacts(paneId, pane),
      })
      .then((made) => {
        this.state = {
          ...this.state,
          tabs: [...this.state.tabs.filter((t) => t.id !== made.tab.id), made.tab],
          panes: [...this.state.panes.filter((p) => p.id !== made.firstPane.id), made.firstPane],
        }
        this.changed()
      })
    return { tabId, paneId, created }
  }

  /** The name the user typed, or null to go back to the label its panes
   *  give it — a real operation and the normal state. */
  async rename(tabId: string, name: string | null): Promise<void> {
    this.replaceTab((await this.client.renameTab(tabId, name)).tab)
  }

  async recolour(tabId: string, colour: string | null): Promise<void> {
    this.replaceTab((await this.client.recolourTab(tabId, colour)).tab)
  }

  async pin(tabId: string, pinned: boolean): Promise<void> {
    this.replaceTab((await this.client.pinTab(tabId, pinned)).tab)
  }

  /**
   * Reorder one workspace's strip.
   *
   * The cache is written from the ANSWER and never from the request, which is
   * the whole of "the renderer decides nothing" in one method: a backend that
   * refuses this leaves the strip exactly where it was, so there is no
   * optimistic move to snap back from.
   */
  async reorder(workspaceId: string, tabIds: readonly string[]): Promise<void> {
    const reordered = (await this.client.reorderTabs(workspaceId, tabIds)).tabs
    const others = this.state.tabs.filter((t) => t.workspaceId !== workspaceId)
    this.state = { ...this.state, tabs: [...reordered, ...others] }
    this.changed()
  }

  /**
   * Remove a pane from the durable chain, and re-read.
   *
   * The re-read is the point rather than a nicety: one close can dissolve the
   * tab it emptied, the workspace that tab was the last of, and mint a
   * replacement tab with a pane — and the answer carries only the closed id,
   * because there is no object left to describe. Reconstructing that here
   * would be the renderer deciding what the chain now looks like. It asks.
   *
   * The replacement's ids are minted here for the same §7 reason as any
   * other: they are durable. They are sent on every close and consulted only
   * when the close would otherwise leave the application with no tab at all.
   */
  async closePane(paneId: string): Promise<Replacement> {
    const replacement: Replacement = { tabId: uuidv7(), paneId: uuidv7(), cwd: '' }
    await this.client.closePane(paneId, replacement)
    await this.load()
    return replacement
  }

  private replaceTab(tab: Tab): void {
    this.state = {
      ...this.state,
      tabs: this.state.tabs.map((t) => (t.id === tab.id ? tab : t)),
    }
    this.changed()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

function paneFacts(id: string, pane: NewPane): PaneFacts {
  return {
    id,
    cwd: pane.cwd,
    kind: pane.kind,
    // An endpoint on a local pane is refused on the way in — the empty string
    // is a real value meaning the local machine, so there is nowhere honest
    // to put it.
    endpoint: pane.kind === 'ssh' ? pane.endpoint : null,
    // One pane fills its tab. A share below 1 arrives with the split
    // (nocx-8m2x6), which is where the second member comes from.
    sizeShare: 1,
  }
}
