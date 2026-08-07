/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/shell.openUrl.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the shell.openUrl JSON-RPC method: the URL was handed to the system browser. The method is a control-plane capability (AD-1) — the renderer has no path to the Wails runtime, so 'open on its hosting' reaches it through the backend, the same shape as dialog.openFile. The result is the empty object, exactly like files.reveal: the browser either opened or the method failed. The backend refuses anything that is not an http(s) URL before it reaches the browser; the method reports itself unavailable (-32601) when no native runtime exists — the dev-web harness has no Wails at all — and the surface toasts the failure.
 */
export interface ShellOpenUrl {}
