/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/files.watch.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the files.watch JSON-RPC method: the refresh mode that now serves this binding's watch set. The call REPLACES the watch set rather than adding to it — the client sends the set it currently wants and the backend diffs, so collapsing a directory cannot leak a watch, and the swap is atomic and idempotent: a newly-added watch that fails to establish must not take the healthy existing watches down with it. The panel is told 'this directory changed' and never learns which mechanism said so; mode is the one exception, and it exists so the UI can say why refresh may lag.
 */
export interface FilesWatchResult {
  /**
   * How the backend detects change for this binding. 'watching': live notifications (local fsnotify) are established. 'polling': the backend compares digest snapshots on a schedule — the designed mode for SFTP, which has no change notification, or a local fallback. The distinction between the first two levels is the whole point: designed-mode polling warns about nothing; degraded mode is a persistent badge.
   */
  mode: 'watching' | 'polling'
  /**
   * Why refresh is degraded. Present only when a local watch could not be established and the backend fell back to polling — a plain string with omitempty semantics, never null — and the renderer shows the persistent 'Polling' warning badge beside Refresh only then, with this as the hover detail, clearing it the instant watching recovers. Absent for the designed modes: a remote binding is never degraded (polling is its designed mode) and a healthy local watch has nothing to explain.
   */
  degradedReason?: string
}
