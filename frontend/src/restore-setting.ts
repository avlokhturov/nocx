// THE frontend half of `restore.onStartup` (nocx-yejir): whether the window
// reopens on what was left.
//
// A module with one owner, like output-cap.ts and for the same reason: the
// answer is needed at BOOT, before any pane exists, and threading it through
// the pane manager's constructor would put a startup decision in a signature
// that is about the window's parts.
//
// It is read ONCE, at boot. Flipping it mid-session must not make tabs appear
// or disappear under the person — it is a decision about what happens the
// NEXT time the application opens, and the settings page says so.

/** The declared key. */
export const RESTORE_ON_STARTUP_KEY = 'restore.onStartup'

/** The declared default (internal/settings/settings.go: RestoreOnStartup).
 *  Used before the first snapshot arrives and whenever the fetch fails: a
 *  failed settings read must not silently give somebody a clean start and
 *  lose the tabs they had. */
export const RESTORE_ON_STARTUP_DEFAULT = true

let restore = RESTORE_ON_STARTUP_DEFAULT

/** Adopt the backend's value. Anything that is not a boolean — an older
 *  backend, a failed fetch — leaves the declared default in place. */
export function applyRestoreOnStartup(value: unknown): void {
  if (typeof value !== 'boolean') return
  restore = value
}

/** Whether boot should reopen what was left. */
export function restoreOnStartup(): boolean {
  return restore
}
