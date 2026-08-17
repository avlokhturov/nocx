/**
 * pane-model — framework‑neutral pane model with named transitions.
 *
 * Derived from: frontend/src/panes.ts
 *   - Pane.id, Pane.descriptor, Pane._title, Pane._hasActivity, Pane._agentStatus,
 *     Pane._disposed  (Pane class, lines 27-258)
 *   - PaneManager.panes, PaneManager.activePane, PaneManager.nextPaneId,
 *     PaneManager.recentPaneIds  (PaneManager class, lines 264-598)
 *
 * Authority:
 *   Pane creation  → composition root (via PaneManager)
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
 * Per-pane model data.
 *
 * Only model-level fields are present.  Render state (pane, viewport observer,
 * mount lifecycle) stays imperative in Pane / PaneManager and is NOT reflected
 * here (AD-6).
 *
 * Derived from: `Pane` class (panes.ts:27-258)
 *   Pane.id → .id
 *   Pane.descriptor → .descriptor
 *   Pane._title → .title
 *   Pane._hasActivity → .hasActivity
 *   Pane._agentStatus → .agentStatus
 *   Pane._disposed → .disposed
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
 * Serializable pane descriptor — mirrors ContentDescriptor (pane-content.ts:127-142)
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
 * The aggregate pane model.
 *
 * Derived from: `PaneManager` class (panes.ts:264-598)
 *   PaneManager.panes → .panes
 *   PaneManager.activePane → .activePaneId (flattened to the pane id)
 *   PaneManager.nextPaneId → .nextPaneId
 *   PaneManager.recentPaneIds → .recentPaneIds
 */
export interface PaneModel {
  readonly panes: readonly PaneData[]
  readonly activePaneId: number | null
  readonly nextPaneId: number
  readonly recentPaneIds: readonly number[]
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create an empty pane model with no panes and a fresh id counter. */
export function createPaneModel(): PaneModel {
  return {
    panes: [],
    activePaneId: null,
    nextPaneId: 1,
    recentPaneIds: [],
  }
}

// ── Pure transition functions ──────────────────────────────────────────────

/**
 * Add a pane to the model and activate it.
 *
 * Authority: composition root (PaneManager.newPane, PaneManager.newSSHPane).
 *
 * Derived from: PaneManager.addPane (panes.ts:403-415)
 */
export function addPane(model: PaneModel, descriptor: PaneDescriptor): PaneModel {
  const id = model.nextPaneId
  const pane: PaneData = {
    id,
    descriptor,
    title: descriptor.defaultTitle,
    hasActivity: false,
    agentStatus: null,
    disposed: false,
  }

  return {
    ...model,
    panes: [...model.panes, pane],
    nextPaneId: id + 1,
    activePaneId: id,
    recentPaneIds: updateRecentPaneIds(id, model.activePaneId, model.recentPaneIds),
  }
}

/**
 * Activate a pane by id.  If the pane is already active, the model is returned
 * unchanged.  The previously-active pane is pushed onto the MRU stack.
 *
 * Authority: tab strip, keyboard shortcuts (Cmd+1..9, Cmd+W).
 *
 * Derived from: PaneManager.activate (panes.ts:499-526)
 */
export function activatePane(model: PaneModel, paneId: number): PaneModel {
  if (model.activePaneId === paneId) return model
  if (!model.panes.some((t) => t.id === paneId && !t.disposed)) return model

  return {
    ...model,
    activePaneId: paneId,
    recentPaneIds: updateRecentPaneIds(paneId, model.activePaneId, model.recentPaneIds),
  }
}

/**
 * Close a pane.  If it was the active pane, the MRU stack is popped to
 * determine the next activation.  Closing the last pane opens a fresh one
 * (the window is never empty).
 *
 * Authority: PaneManager (keyboard shortcut, tab strip close button).
 *
 * Derived from: PaneManager.closePane (panes.ts:473-496)
 */
export function closePane(model: PaneModel, paneId: number): PaneModel {
  const index = model.panes.findIndex((t) => t.id === paneId)
  if (index === -1) return model

  const wasActive = model.activePaneId === paneId
  const nextRecent = model.recentPaneIds.filter((id) => id !== paneId)
  const nextPanes = model.panes.filter((t) => t.id !== paneId)

  if (nextPanes.length === 0) {
    // Last pane closed — create a fresh terminal pane.
    return addPane(
      {
        ...model,
        panes: [],
        activePaneId: null,
        recentPaneIds: nextRecent,
      },
      DEFAULT_TERMINAL_DESCRIPTOR,
    )
  }

  let activePaneId = model.activePaneId
  if (wasActive) {
    // Pop the MRU stack until we find a live pane.
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
    panes: nextPanes,
    activePaneId,
    recentPaneIds: nextRecent,
  }
}

/**
 * Reorder a pane from its current position to the position of another pane.
 *
 * Authority: tab strip (drag-and-drop reorder).
 *
 * Derived from: PaneManager.reorderPane (panes.ts:537-547)
 */
export function reorderPane(model: PaneModel, draggedId: number, targetId: number): PaneModel {
  const draggedIndex = model.panes.findIndex((t) => t.id === draggedId)
  const targetIndex = model.panes.findIndex((t) => t.id === targetId)
  if (draggedIndex === -1 || targetIndex === -1) return model

  const nextPanes = [...model.panes]
  const [draggedPane] = nextPanes.splice(draggedIndex, 1)
  const adjustedTarget = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex
  nextPanes.splice(adjustedTarget, 0, draggedPane)

  return { ...model, panes: nextPanes }
}

/**
 * Update a pane's display title.
 *
 * Authority: content (via PaneHost.setTitle).
 *
 * Derived from: Pane.setTitle → Pane._title (panes.ts:27-258)
 */
export function updatePaneTitle(model: PaneModel, paneId: number, title: string): PaneModel {
  return updatePane(model, paneId, (pane) => ({ ...pane, title }))
}

/**
 * Set a pane's activity indicator.
 *
 * Authority: content (via PaneHost.requestAttention).
 *
 * Derived from: Pane.requestAttention → Pane._hasActivity (panes.ts:27-258)
 */
export function updatePaneActivity(
  model: PaneModel,
  paneId: number,
  hasActivity: boolean,
): PaneModel {
  return updatePane(model, paneId, (pane) => ({ ...pane, hasActivity }))
}

/**
 * Set a pane's agent status.
 *
 * Authority: terminal renderer (via TerminalRenderer.onTitle).
 *
 * Derived from: Pane._agentStatus (panes.ts:27-258)
 */
export function updatePaneAgentStatus(
  model: PaneModel,
  paneId: number,
  status: AgentStatus | null,
): PaneModel {
  return updatePane(model, paneId, (pane) => ({ ...pane, agentStatus: status }))
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
function updateRecentPaneIds(
  activatedId: number,
  previouslyActive: number | null,
  recent: readonly number[],
): number[] {
  const next = recent.filter((id) => id !== activatedId && id !== previouslyActive)
  if (previouslyActive !== null) next.push(previouslyActive)
  return next
}

/** Helper: apply a per-pane updater to the matching pane. */
function updatePane(
  model: PaneModel,
  paneId: number,
  updater: (pane: PaneData) => PaneData,
): PaneModel {
  const index = model.panes.findIndex((t) => t.id === paneId)
  if (index === -1) return model
  const nextPanes = [...model.panes]
  nextPanes[index] = updater(nextPanes[index])
  return { ...model, panes: nextPanes }
}
