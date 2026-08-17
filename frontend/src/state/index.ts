/**
 * state — barrel re‑exports.
 *
 * Application state module: Solid signals/stores holding ACCEPTED state only,
 * with every transition and authority rule in framework‑neutral TypeScript.
 *
 * Terminal render state is NOT exported from this module (AD-6).
 */

// ── Framework‑neutral models ──────────────────────────────────────────────

export { createBannerState, type BannerState } from './banner-model'
export { createProfileLists, setProfileLists, type ProfileLists } from './profiles-model'
export { createSidebarState, type SidebarState } from './sidebar-model'
// ── Settings (re‑exported from settings-domain, q.v.) ─────────────────────

export {
  AcceptedSnapshot,
  applyAcceptedSnapshot,
  canResetSetting,
  createMirror,
  monotonicRevisionPolicy,
  reconnectRevisionPolicy,
  recordSaveOutcome,
} from './settings-model'

export type {
  ResetAllowed,
  ResetDecision,
  ResetDenied,
  ResetReason,
  RevisionPolicy,
  SaveOutcome,
  SettingsMirror,
  SettingsSnapshot,
} from './settings-model'

// ── Solid store ───────────────────────────────────────────────────────────

export { createAppStore, type AppActions, type AppState } from './store'
