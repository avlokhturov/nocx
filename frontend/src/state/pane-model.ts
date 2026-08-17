/**
 * tab-model — framework‑neutral tab model with named transitions.
 *
 * Derived from: frontend/src/tabs.ts
 *   - Tab.id, Tab.descriptor, Tab._title, Tab._hasActivity, Tab._agentStatus,
 *     Tab._disposed  (Tab class, lines 27-258)
 *   - PaneManager.tabs, PaneManager.activePane, PaneManager.nextPaneId,
 *     PaneManager.recentPaneIds  (PaneManager class, lines 264-598)
 *
 * Authority:
 *   Tab creation  → composition root (via PaneManager equivalent)
 *   Activation    → tab strip / keyboard shortcuts
 *   Title         → content (via PaneHost.setTitle)
 *   Activity      → content (via PaneHost.requestAttention)
 *   Agent status  → terminal renderer (via TerminalRenderer.onTitle)
 *   Disposal      → PaneManager (on close)
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
 * mount lifecycle) stays imperative in Tab / PaneManager and is NOT reflected
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
export interface PaneData {
  readonly id: number
  readonly descriptor: PaneDescriptor
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
export interface PaneDescriptor {
  readonly surfaceType: string
  readonly singletonKey: string | null
  readonly restoreDescriptor: unknown
  readonly supportsAttention: boolean
  readonly defaultTitle: string
}

/**
 * The aggregate tab model.
 *
 * Derived from: `PaneManager` class (tabs.ts:264-598)
 *   PaneManager.tabs → .tabs
 *   PaneManager.activePane → .activePaneId (flattened to the tab id)
 *   PaneManager.nextPaneId → .nextPaneId
 *   PaneManager.recentPaneIds → .recentPaneIds
 */
export interface PaneModel {
  readonly tabs: readonly PaneData[]
  readonly activePaneId: number | null
  readonly nextPaneId: number
  readonly recentPaneIds: readonly number[]
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create an empty tab model with no tabs and a fresh id counter. */
export function createPaneModel(): PaneModel {
  return {
    tabs: [],
    activePaneId: null,
    nextPaneId: 1,
    recentPaneIds: [],
  }
}

// ── Pure transition functions ──────────────────────────────────────────────

/**
 * Add a tab to the model and activate it.
 *
 * Authority: composition root (PaneManager.newPane, PaneManager.newSSHPane).
 *
 * Derived from: PaneManager.addPane (tabs.ts:403-415)
 */
export function addPane(model: PaneModel, descriptor: PaneDescriptor): PaneModel {
  const id = model.nextPaneId
  const tab: PaneData = {
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
    nextPaneId: id + 1,
    activePaneId: id,
    recentPaneIds: updateRecentTabIds(id, model.activePaneId, model.recentPaneIds),
  }
}

/**
 * Activate a tab by id.  If the tab is already active, the model is returned
 * unchanged.  The previously-active tab is pushed onto the MRU stack.
 *
 * Authority: tab strip, keyboard shortcuts (Cmd+1..9, Cmd+W).
 *
 * Derived from: PaneManager.activate (tabs.ts:499-526)
 */
export function activatePane(model: PaneModel, paneId: number): PaneModel {
  if (model.activePaneId === paneId) return model
  if (!model.tabs.some((t) => t.id === paneId && !t.disposed)) return model

  return {
    ...model,
    activePaneId: paneId,
    recentPaneIds: updateRecentTabIds(paneId, model.activePaneId, model.recentPaneIds),
  }
}

/**
 * Close a tab.  If it was the active tab, the MRU stack is popped to
 * determine the next activation.  Closing the last tab opens a fresh one
 * (the window is never empty).
 *
 * Authority: PaneManager (keyboard shortcut, tab strip close button).
 *
 * Derived from: PaneManager.closePane (tabs.ts:473-496)
 */
export function closePane(model: PaneModel, paneId: number): PaneModel {
  const index = model.tabs.findIndex((t) => t.id === paneId)
  if (index === -1) return model

  const wasActive = model.activePaneId === paneId
  const nextRecent = model.recentPaneIds.filter((id) => id !== paneId)
  const nextPanes = model.tabs.filter((t) => t.id !== paneId)

  if (nextPanes.length === 0) {
    // Last tab closed — create a fresh terminal tab.
    return addPane(
      {
        ...model,
        tabs: [],
        activePaneId: null,
        recentPaneIds: nextRecent,
      },
      DEFAULT_TERMINAL_DESCRIPTOR,
    )
  }

  let activePaneId = model.activePaneId
  if (wasActive) {
    // Pop the MRU stack until we find a live tab.
    const mruCandidates = [...nextRecent].reverse()
    activePaneId = null
    for (const mruId of mruCandidates) {
      if (nextPanes.some((t) => t.id === mruId && !t.disposed)) {
        activePaneId = mruId
        break
      }
    }
    if (activePaneId === null && nextPanes.length > 0) {
      activePaneId = nextPanes[0].id
    }
  }

  return {
    ...model,
    tabs: nextPanes,
    activePaneId,
    recentPaneIds: nextRecent,
  }
}

/**
 * Reorder a tab from its current position to the position of another tab.
 *
 * Authority: tab strip (drag-and-drop reorder).
 *
 * Derived from: PaneManager.reorderPane (tabs.ts:537-547)
 */
export function reorderPane(model: PaneModel, draggedId: number, targetId: number): PaneModel {
  const draggedIndex = model.tabs.findIndex((t) => t.id === draggedId)
  const targetIndex = model.tabs.findIndex((t) => t.id === targetId)
  if (draggedIndex === -1 || targetIndex === -1) return model

  const nextPanes = [...model.tabs]
  const [draggedTab] = nextPanes.splice(draggedIndex, 1)
  const adjustedTarget = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex
  nextPanes.splice(adjustedTarget, 0, draggedTab)

  return { ...model, tabs: nextPanes }
}

/**
 * Update a tab's display title.
 *
 * Authority: content (via PaneHost.setTitle).
 *
 * Derived from: Pane.setTitle → Tab._title (tabs.ts:27-258)
 */
export function updatePaneTitle(model: PaneModel, paneId: number, title: string): PaneModel {
  return updateTab(model, paneId, (tab) => ({ ...tab, title }))
}

/**
 * Set a tab's activity indicator.
 *
 * Authority: content (via PaneHost.requestAttention).
 *
 * Derived from: Pane.requestAttention → Tab._hasActivity (tabs.ts:27-258)
 */
export function updatePaneActivity(
  model: PaneModel,
  paneId: number,
  hasActivity: boolean,
): PaneModel {
  return updateTab(model, paneId, (tab) => ({ ...tab, hasActivity }))
}

/**
 * Set a tab's agent status.
 *
 * Authority: terminal renderer (via TerminalRenderer.onTitle).
 *
 * Derived from: Pane._agentStatus (tabs.ts:27-258)
 */
export function updatePaneAgentStatus(
  model: PaneModel,
  paneId: number,
  status: AgentStatus | null,
): PaneModel {
  return updateTab(model, paneId, (tab) => ({ ...tab, agentStatus: status }))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_TERMINAL_DESCRIPTOR: PaneDescriptor = {
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
function updateTab(
  model: PaneModel,
  paneId: number,
  updater: (tab: PaneData) => PaneData,
): PaneModel {
  const index = model.tabs.findIndex((t) => t.id === paneId)
  if (index === -1) return model
  const nextPanes = [...model.tabs]
  nextPanes[index] = updater(nextPanes[index])
  return { ...model, tabs: nextPanes }
}
