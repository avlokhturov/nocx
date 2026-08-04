/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/shell.integrate.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the shell.integrate JSON-RPC method: the in-band bootstrap plan the renderer executes at a trusted prompt — the wrapper line typed at the prompt, the payload streamed through the raw-mode window, and the delimiter line that ends (or cancels) the stream (spec §4.4, nocx-ynsx).
 */
export interface ShellIntegrateResult {
  /**
   * The single line typed at the prompt: captures the exact prior termios with `stty -g`, enters raw -echo mode, emits the READY OSC only after raw mode is on, stages the payload through sed until the terminator line, and restores with `stty "$saved"` on every path.
   */
  wrapper: string
  /**
   * The integration payload: a POSIX-sh dispatcher plus the bash/zsh/posix hook scripts framed by section markers, ending with the completion marker line. Streamed only after READY; never sourced without the completion marker.
   */
  payload: string
  /**
   * The delimiter line that ends the payload stream. The renderer appends it (with a trailing newline) after the payload, or sends it alone to cancel an in-flight integration.
   */
  terminator: string
}
