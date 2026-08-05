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
 * The delivery planner's decision for a hand-typed ssh invocation (nocx-mlm7 P7). The planner mints a fresh environmentId per attempt (never the tab session id), decides whether the host gets the bootstrap launcher or the compact installed line, and returns the pieces the renderer needs to build the rewritten line. mode 'raw' means no rewrite: the renderer sends the line the user typed unchanged (fail-open, ADR-0004 §1).
 */
export interface ShellLauncherCommandResult {
  /**
   * The planner's decision. 'bootstrap' stages a launcher the renderer splices into the line with `$(cat …)`; 'installed' sends the compact guard-travelling line with the environment id; 'raw' sends the typed line unchanged.
   */
  mode: 'bootstrap' | 'installed' | 'raw'
  /**
   * A fresh environment-transition id minted for THIS attempt, in the passport charset [A-Za-z0-9._-]{1,64}. The renderer registers it with the passport tracker as expected BEFORE the rewritten line reaches the pty. Two attempts from one tab carry different ids.
   */
  environmentId: string
  /**
   * The shell-quoted absolute path of the staged launcher file, ready to splice into a shell line the local shell reads with `$(cat …)`. Non-null only when mode is 'bootstrap'.
   */
  launcherPath: string | null
  /**
   * Why the rewrite was refused. Non-null only when mode is 'raw'. 'oracle-failed' when ssh -G is missing, timed out or failed (nocx-qwhp: a failed oracle refuses, never rewrites on a guess). 'remote-command' when the resolved config sets RemoteCommand. 'unsupported' when the launcher cannot build a command. 'stage-failed' when the launcher could not be staged.
   */
  reason: null | 'remote-command' | 'oracle-failed' | 'unsupported' | 'stage-failed'
}
