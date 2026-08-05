/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/shell.complete.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the shell.complete JSON-RPC method — completion candidates from the session's shell. For a local session this answers from the backend's own filesystem (identical to fs.complete); for an SSH session it runs a second shell on the remote host through the DiscoveryConn lane (ADR-0020) and returns what the remote shell's completion machinery produces — paths from the remote filesystem, command names, and command-specific completions from bash completion functions. Each candidate carries its source so the UI can distinguish an adapter answer from a local guess.
 */
export interface ShellComplete {
  /**
   * The completion candidates, sorted by the shell's own ordering. Never null: no matches is [].
   */
  entries: ShellEntry[]
  /**
   * True when the result hit a capture bound or the response was truncated — the list is not complete. The renderer may surface this as a soft indication; it is never an error.
   */
  truncated: boolean
  /**
   * A stated explanation when entries is empty. The product shows this instead of the generic 'no matches'. Empty/absent = no specific reason.
   */
  reason?: string
}
export interface ShellEntry {
  /**
   * The candidate's display name — the last path segment for a file, the command name for a command, the completion word for a function answer.
   */
  name: string
  /**
   * The absolute path of a path candidate. Absent for non-path candidates (commands, function completions).
   */
  path?: string
  /**
   * Where the answer came from: 'path' (compgen -f / compgen -d), 'command' (compgen -c), or 'function' (a bash completion function). The UI uses this to distinguish an adapter answer from a local guess and to show the appropriate evidence column.
   */
  source: 'path' | 'command' | 'function'
  /**
   * True when a path candidate is a directory. The renderer appends a trailing slash and treats directory acceptance as a step rather than a terminal close.
   */
  isDir?: boolean
}
