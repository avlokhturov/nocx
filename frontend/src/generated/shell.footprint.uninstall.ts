/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/shell.footprint.uninstall.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * What removing the integration bundle from a remote host did (P10). Only manifest-owned, unmodified files are removed; anything the user changed is a reported conflict and stays; ~/.nocx is never removed recursively. The two lists are root-relative paths — a conflict is information the user acts on, never an error to swallow.
 */
export interface ShellFootprintUninstallResult {
  /**
   * Root-relative paths removed, including the manifest itself. Empty when nothing was installed or everything had already gone.
   */
  removed: string[]
  /**
   * Root-relative paths the user modified since the install; left in place. Empty when every manifest-owned file was unmodified.
   */
  conflicts: string[]
}
