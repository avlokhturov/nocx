/**
 * store — Solid signals and stores holding ACCEPTED application state.
 *
 * Every write goes through a named transition in framework‑neutral TypeScript.
 * The store imports from the model files, never from Solid in the transition
 * functions themselves (ADR-0012 §2).
 *
 * Slice ownership:
 *   paneModel   → tab-model.ts  (ordered tabs, active tab, MRU)
 *   sidebar    → sidebar-model.ts  (collapsed, active view)
 *   settings   → settings-domain.ts  (mirror, revision, transitions)
 *   profiles   → profiles-model.ts  (connection profiles list)
 *   banner     → banner-model.ts  (clipboard banner shown)
 *
 * Terminal render state does NOT appear here (AD-6).
 */

import { createStore } from 'solid-js/store'
import type { AgentStatus } from '../agent-status'
import type { SettingsMirror, SettingsSnapshot } from '../settings-domain'
import { createMirror } from '../settings-domain'
import { createBannerState, type BannerState } from './banner-model'
import type { ProfileGroup, SSHProfile } from '../profiles'
import {
  createProfileLists,
  setProfileLists as updateProfileLists,
  type ProfileLists,
} from './profiles-model'
import { createSidebarState, type SidebarState } from './sidebar-model'
import {
  addPane,
  activatePane as activateTabModel,
  closePane as closeTabModel,
  createPaneModel,
  reorderPane as reorderTabModel,
  updatePaneActivity as updateTabActivityModel,
  updatePaneAgentStatus as updateTabAgentStatusModel,
  updatePaneTitle as updateTabTitleModel,
  type PaneDescriptor,
  type PaneModel,
} from './pane-model'

// ── Application state tree ─────────────────────────────────────────────────

export interface AppState {
  paneModel: PaneModel
  sidebar: SidebarState
  settings: SettingsMirror
  profiles: ProfileLists
  banner: BannerState
}

function createInitialState(): AppState {
  return {
    paneModel: createPaneModel(),
    sidebar: createSidebarState(),
    settings: createMirror(),
    profiles: createProfileLists(),
    banner: createBannerState(),
  }
}

// ── Create the state store ─────────────────────────────────────────────────

/**
 * Create the Solid store holding all accepted application state.
 *
 * Returns a tuple [state, actions] where `actions` are named transitions
 * that wrap the framework‑neutral transition functions.  Consumers call
 * `actions.addPane(...)`, not `setState(...)` directly.
 */
export function createAppStore(): [AppState, AppActions] {
  const [state, setState] = createStore<AppState>(createInitialState())

  const actions: AppActions = {
    // ── Tab transitions ──────────────────────────────────────────────────
    addPane: (descriptor: PaneDescriptor) => {
      setState('paneModel', (prev) => addPane(prev, descriptor))
    },

    activatePane: (paneId: number) => {
      setState('paneModel', (prev) => activateTabModel(prev, paneId))
    },

    closePane: (paneId: number) => {
      setState('paneModel', (prev) => closeTabModel(prev, paneId))
    },

    reorderPane: (draggedId: number, targetId: number) => {
      setState('paneModel', (prev) => reorderTabModel(prev, draggedId, targetId))
    },

    updatePaneTitle: (paneId: number, title: string) => {
      setState('paneModel', (prev) => updateTabTitleModel(prev, paneId, title))
    },

    updatePaneActivity: (paneId: number, hasActivity: boolean) => {
      setState('paneModel', (prev) => updateTabActivityModel(prev, paneId, hasActivity))
    },

    updatePaneAgentStatus: (paneId: number, status: AgentStatus | null) => {
      setState('paneModel', (prev) => updateTabAgentStatusModel(prev, paneId, status))
    },

    // ── Sidebar transitions ──────────────────────────────────────────────
    toggleSidebar: () => {
      setState('sidebar', (prev) => ({
        ...prev,
        collapsed: !prev.collapsed,
      }))
    },
    setActiveView: (viewId: string) => {
      setState('sidebar', (prev) => {
        if (viewId === prev.activeViewId && !prev.collapsed) {
          return { ...prev, collapsed: true }
        }
        return { ...prev, activeViewId: viewId }
      })
    },
    collapseSidebar: () => {
      setState('sidebar', (prev) => (prev.collapsed ? prev : { ...prev, collapsed: true }))
    },

    // ── Settings transitions ─────────────────────────────────────────────
    setSettingsValues: (values: Record<string, unknown>) => {
      setState('settings', 'values', values)
    },

    setSettingsDraftValues: (drafts: Record<string, unknown>) => {
      setState('settings', 'draftValues', drafts)
    },

    setSettingsOverridden: (overridden: Set<string>) => {
      setState('settings', 'overridden', overridden)
    },

    setSettingsErrors: (errors: Record<string, string>) => {
      setState('settings', 'errors', errors)
    },

    setSettingsRevision: (revision: number) => {
      setState('settings', 'revision', revision)
    },

    applySettingsSnapshot: (snapshot: SettingsSnapshot) => {
      setState('settings', {
        values: { ...snapshot.values },
        draftValues: {},
        overridden: new Set(snapshot.overridden),
        errors: {},
        revision: snapshot.revision,
      })
    },

    // ── Profile transitions ──────────────────────────────────────────────
    setProfiles: (profiles: readonly SSHProfile[], groups: readonly ProfileGroup[]) => {
      setState('profiles', (prev) => updateProfileLists(prev, profiles, groups))
    },

    // ── Banner transitions ───────────────────────────────────────────────
    showBanner: () => {
      setState('banner', (prev) => ({ ...prev, shown: true }))
    },
    dismissBanner: () => {
      setState('banner', (prev) => ({ ...prev, shown: false }))
    },

    // ── Full reset ───────────────────────────────────────────────────────
    reset: () => {
      setState(createInitialState())
    },
  }

  return [state, actions]
}

// ── Named transitions interface ────────────────────────────────────────────

export interface AppActions {
  /** Add a tab to the model and activate it. */
  addPane: (descriptor: PaneDescriptor) => void
  /** Activate a tab by id (updates MRU). */
  activatePane: (paneId: number) => void
  /** Close a tab.  If last tab, opens a fresh terminal. */
  closePane: (paneId: number) => void
  /** Reorder a tab by dragging. */
  reorderPane: (draggedId: number, targetId: number) => void
  /** Set a tab's display title. */
  updatePaneTitle: (paneId: number, title: string) => void
  /** Set a tab's activity indicator. */
  updatePaneActivity: (paneId: number, hasActivity: boolean) => void
  /** Set a tab's agent status. */
  updatePaneAgentStatus: (paneId: number, status: AgentStatus | null) => void

  /** Toggle sidebar collapsed state. */
  toggleSidebar: () => void
  /** Set the active sidebar view (may toggle collapsed). */
  setActiveView: (viewId: string) => void
  /** Collapse the sidebar unconditionally. */
  collapseSidebar: () => void

  /** Replace all settings values. */
  setSettingsValues: (values: Record<string, unknown>) => void
  /** Replace all settings draft values. */
  setSettingsDraftValues: (drafts: Record<string, unknown>) => void
  /** Replace the overridden keys set. */
  setSettingsOverridden: (overridden: Set<string>) => void
  /** Replace all settings errors. */
  setSettingsErrors: (errors: Record<string, string>) => void
  /** Set the settings revision number. */
  setSettingsRevision: (revision: number) => void
  /** Apply a backend snapshot to the settings mirror. */
  applySettingsSnapshot: (snapshot: SettingsSnapshot) => void

  /** Replace the profile lists. */
  setProfiles: (profiles: readonly SSHProfile[], groups: readonly ProfileGroup[]) => void
  /** Mark the clipboard banner as shown. */
  showBanner: () => void
  /** Clear the clipboard banner shown flag. */
  dismissBanner: () => void

  /** Reset all state to initial values. */
  reset: () => void
}
