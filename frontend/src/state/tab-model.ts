/**
 * tab-model — framework‑neutral tab model with named transitions.
 *
 * Derived from: frontend/src/tabs.ts
 *   - Tab.id, Tab.descriptor, Tab._title, Tab._hasActivity, Tab._agentStatus,
 *     Tab._disposed  (Tab class, lines 27-258)
 *   - TabManager.tabs, TabManager.activeTab, TabManager.nextTabId,
 *     TabManager.recentTabIds  (TabManager class, lines 264-598)
 *
 * Authority:
 *   Tab creation  → composition root (via TabManager equivalent)
 *   Activation    → tab strip / keyboard shortcuts
 *   Title         → content (via TabHost.setTitle)
 *   Activity      → content (via TabHost.requestAttention)
 *   Agent status  → terminal renderer (via TerminalRenderer.onTitle)
 *   Disposal      → TabManager (on close)
 *
 * Terminal render state (grid, scrollback, selection, per-cell data) is NOT
 * modeled here — it stays inside the terminal controller per AD-6.
 */

import type { AgentStatus } from '../agent-status'

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Per-tab model data.
 *
 * Only model-level fields are present.  Render state (pane, viewport observer,
 * mount lifecycle) stays imperative in Tab / TabManager and is NOT reflected
 * here (AD-6).
 *
 * Derived from: `Tab` class (tabs.ts:27-258)
 *   Tab.id → .id
 *   Tab.descriptor → .descriptor
 *   Tab._title → .title
 *   Tab._hasActivity → .hasActivity
 *   Tab._agentStatus → .agentStatus
 *   Tab._disposed → .disposed
 */
export interface TabData {
  readonly id: number
  readonly descriptor: TabDescriptor
  title: string
  hasActivity: boolean
  agentStatus: AgentStatus | null
  disposed: boolean
}

/**
 * Serializable tab descriptor — mirrors ContentDescriptor (tab-content.ts:127-142)
 * minus the SurfaceType/SingletonKey branded types (kept as string | null for
 * framework‑neutrality).
 */
export interface TabDescriptor {
  readonly surfaceType: string
  readonly singletonKey: string | null
  readonly restoreDescriptor: unknown
  readonly supportsAttention: boolean
  readonly defaultTitle: string
}

/**
 * The aggregate tab model.
 *
 * Derived from: `TabManager` class (tabs.ts:264-598)
 *   TabManager.tabs → .tabs
 *   TabManager.activeTab → .activeTabId (flattened to the tab id)
 *   TabManager.nextTabId → .nextTabId
 *   TabManager.recentTabIds → .recentTabIds
 */
export interface TabModel {
  readonly tabs: readonly TabData[]
  readonly activeTabId: number | null
  readonly nextTabId: number
  readonly recentTabIds: readonly number[]
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create an empty tab model with no tabs and a fresh id counter. */
export function createTabModel(): TabModel {
  return {
    tabs: [],
    activeTabId: null,
    nextTabId: 1,
    recentTabIds: [],
  }
}

// ── Pure transition functions ──────────────────────────────────────────────

/**
 * Add a tab to the model and activate it.
 *
 * Authority: composition root (TabManager.newTab, TabManager.newSSHTab).
 *
 * Derived from: TabManager.addTab (tabs.ts:403-415)
 */
export function addTab(model: TabModel, descriptor: TabDescriptor): TabModel {
  const id = model.nextTabId
  const tab: TabData = {
    id,
    descriptor,
    title: descriptor.defaultTitle,
    hasActivity: false,
    agentStatus: null,
    disposed: false,
  }

  return {
    ...model,
    tabs: [...model.tabs, tab],
    nextTabId: id + 1,
    activeTabId: id,
    recentTabIds: updateRecentTabIds(id, model.activeTabId, model.recentTabIds),
  }
}

/**
 * Activate a tab by id.  If the tab is already active, the model is returned
 * unchanged.  The previously-active tab is pushed onto the MRU stack.
 *
 * Authority: tab strip, keyboard shortcuts (Cmd+1..9, Cmd+W).
 *
 * Derived from: TabManager.activate (tabs.ts:499-526)
 */
export function activateTab(model: TabModel, tabId: number): TabModel {
  if (model.activeTabId === tabId) return model
  if (!model.tabs.some((t) => t.id === tabId && !t.disposed)) return model

  return {
    ...model,
    activeTabId: tabId,
    recentTabIds: updateRecentTabIds(tabId, model.activeTabId, model.recentTabIds),
  }
}

/**
 * Close a tab.  If it was the active tab, the MRU stack is popped to
 * determine the next activation.  Closing the last tab opens a fresh one
 * (the window is never empty).
 *
 * Authority: TabManager (keyboard shortcut, tab strip close button).
 *
 * Derived from: TabManager.closeTab (tabs.ts:473-496)
 */
export function closeTab(model: TabModel, tabId: number): TabModel {
  const index = model.tabs.findIndex((t) => t.id === tabId)
  if (index === -1) return model

  const wasActive = model.activeTabId === tabId
  const nextRecent = model.recentTabIds.filter((id) => id !== tabId)
  const nextTabs = model.tabs.filter((t) => t.id !== tabId)

  if (nextTabs.length === 0) {
    // Last tab closed — create a fresh terminal tab.
    return addTab(
      {
        ...model,
        tabs: [],
        activeTabId: null,
        recentTabIds: nextRecent,
      },
      DEFAULT_TERMINAL_DESCRIPTOR,
    )
  }

  let activeTabId = model.activeTabId
  if (wasActive) {
    // Pop the MRU stack until we find a live tab.
    const mruCandidates = [...nextRecent].reverse()
    activeTabId = null
    for (const mruId of mruCandidates) {
      if (nextTabs.some((t) => t.id === mruId && !t.disposed)) {
        activeTabId = mruId
        break
      }
    }
    if (activeTabId === null && nextTabs.length > 0) {
      activeTabId = nextTabs[0].id
    }
  }

  return {
    ...model,
    tabs: nextTabs,
    activeTabId,
    recentTabIds: nextRecent,
  }
}

/**
 * Reorder a tab from its current position to the position of another tab.
 *
 * Authority: tab strip (drag-and-drop reorder).
 *
 * Derived from: TabManager.reorderTab (tabs.ts:537-547)
 */
export function reorderTab(model: TabModel, draggedId: number, targetId: number): TabModel {
  const draggedIndex = model.tabs.findIndex((t) => t.id === draggedId)
  const targetIndex = model.tabs.findIndex((t) => t.id === targetId)
  if (draggedIndex === -1 || targetIndex === -1) return model

  const nextTabs = [...model.tabs]
  const [draggedTab] = nextTabs.splice(draggedIndex, 1)
  const adjustedTarget = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex
  nextTabs.splice(adjustedTarget, 0, draggedTab)

  return { ...model, tabs: nextTabs }
}

/**
 * Update a tab's display title.
 *
 * Authority: content (via TabHost.setTitle).
 *
 * Derived from: Tab.setTitle → Tab._title (tabs.ts:27-258)
 */
export function updateTabTitle(model: TabModel, tabId: number, title: string): TabModel {
  return updateTab(model, tabId, (tab) => ({ ...tab, title }))
}

/**
 * Set a tab's activity indicator.
 *
 * Authority: content (via TabHost.requestAttention).
 *
 * Derived from: Tab.requestAttention → Tab._hasActivity (tabs.ts:27-258)
 */
export function updateTabActivity(model: TabModel, tabId: number, hasActivity: boolean): TabModel {
  return updateTab(model, tabId, (tab) => ({ ...tab, hasActivity }))
}

/**
 * Set a tab's agent status.
 *
 * Authority: terminal renderer (via TerminalRenderer.onTitle).
 *
 * Derived from: Tab._agentStatus (tabs.ts:27-258)
 */
export function updateTabAgentStatus(
  model: TabModel,
  tabId: number,
  status: AgentStatus | null,
): TabModel {
  return updateTab(model, tabId, (tab) => ({ ...tab, agentStatus: status }))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_TERMINAL_DESCRIPTOR: TabDescriptor = {
  surfaceType: 'nocx.terminal',
  singletonKey: null,
  restoreDescriptor: { type: 'local' },
  supportsAttention: true,
  defaultTitle: 'Terminal',
}

/**
 * Push `activatedId` onto the MRU stack, replacing any prior entry and
 * removing `previouslyActive` from the stack bottom (it just moved up).
 */
function updateRecentTabIds(
  activatedId: number,
  previouslyActive: number | null,
  recent: readonly number[],
): number[] {
  const next = recent.filter((id) => id !== activatedId && id !== previouslyActive)
  if (previouslyActive !== null) next.push(previouslyActive)
  return next
}

/** Helper: apply a per-tab updater to the matching tab. */
function updateTab(model: TabModel, tabId: number, updater: (tab: TabData) => TabData): TabModel {
  const index = model.tabs.findIndex((t) => t.id === tabId)
  if (index === -1) return model
  const nextTabs = [...model.tabs]
  nextTabs[index] = updater(nextTabs[index])
  return { ...model, tabs: nextTabs }
}
