/**
 * settings-model — re‑exports and extends settings-domain for the state module.
 *
 * The core types and transitions live in settings-domain.ts as the canonical
 * framework‑neutral pattern.  This file re‑exports them and adds any store‑
 * specific wrappers.
 *
 * Derivation:
 *   settings-domain.ts (the worked example) — AcceptedSnapshot, SettingsMirror,
 *     SettingsSnapshot, RevisionPolicy, monotonicRevisionPolicy,
 *     reconnectRevisionPolicy, createMirror, recordSaveOutcome,
 *     canResetSetting, applyAcceptedSnapshot
 *
 *   settings.ts:82-106 (SettingsViewImpl fields)
 *     .values → mirror.values
 *     .draftValues → mirror.draftValues
 *     .overridden → mirror.overridden
 *     .errors → mirror.errors
 *     .revision → mirror.revision
 *
 * Authority:
 *   Mirror population → settings-domain.ts (AcceptedSnapshot accept/reset gate)
 *   Setting updates   → settings-domain.ts (recordSaveOutcome)
 *   Reset decisions   → settings-domain.ts (canResetSetting)
 */

export {
  AcceptedSnapshot,
  applyAcceptedSnapshot,
  canResetSetting,
  createMirror,
  monotonicRevisionPolicy,
  reconnectRevisionPolicy,
  recordSaveOutcome,
} from '../settings-domain'

export type {
  ResetAllowed,
  ResetDecision,
  ResetDenied,
  ResetReason,
  RevisionPolicy,
  SaveOutcome,
  SettingsMirror,
  SettingsSnapshot,
} from '../settings-domain'
