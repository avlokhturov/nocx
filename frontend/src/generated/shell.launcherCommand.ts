/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/shell.launcherCommand.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Where the remote launcher was staged for rewriting a hand-typed ssh invocation (nocx-pu4.6). The launcher itself is ~35 KB and cannot cross the tty — a canonical line buffer is 4096 bytes — so the backend writes it to a private file and the renderer types only the path.
 */
export interface ShellLauncherCommandResult {
  /**
   * The shell-quoted absolute path of the staged launcher file, ready to splice into a shell line the local shell reads with `$(cat …)`. Null when the rewrite is refused.
   */
  launcherPath: string | null
  /**
   * Why the rewrite was refused. Null when launcherPath is non-null. 'remote-command' when the destination's ssh config sets RemoteCommand. 'unsupported' when the launcher cannot build a command for this shell. 'stage-failed' when the launcher could not be written where the local shell can read it.
   */
  reason: null | 'remote-command' | 'unsupported' | 'stage-failed'
}
