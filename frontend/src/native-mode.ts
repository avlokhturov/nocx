// Native-mode escape (ADR-0004 §1, nocx-4ff.9) — SEVERED by ADR-0024.
// The `shouldShowEditor(owned, nativeMode)` boolean axis is deleted: the
// editor owns keys only when an authenticated lifecycle says PromptReady
// (ADR-0024 §6), and no stream marker may grant ownership. In the severed
// world input is always native and the editor never shows; NATIVE_RESTORE
// remains for the session-restore gesture only.
export const NATIVE_RESTORE = '__nocx_native_mode\r'
