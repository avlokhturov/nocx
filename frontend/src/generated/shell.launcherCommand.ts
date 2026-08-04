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
 * The remote launcher command for rewriting a hand-typed ssh invocation (nocx-pu4.6).
 */
export interface ShellLauncherCommandResult {
  /**
   * The shell-quoted remote launcher command, ready to append to an ssh command line. Null when the rewrite is refused.
   */
  launcher: string | null
  /**
   * Why the rewrite was refused. Null when launcher is non-null. 'remote-command' when the destination's ssh config sets RemoteCommand. 'policy-off' when the shell integration policy is off. 'unsupported' when the launcher cannot build a command for this shell.
   */
  reason: null | 'remote-command' | 'unsupported'
}
