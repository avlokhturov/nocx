// Footprint RPC client — typed methods for the shell.footprint.* control-
// plane methods (nocx-mlm7 P10, delivery-modes design §4.1/§9): the visible
// footprint of nocx's silent install, and the uninstall action.
//
// shell.footprint.status is READ-ONLY and never connects: the answer is the
// backend's installed fact (last OBSERVED via an accepted passport), so the
// surface can show a host nocx can no longer reach, and lastObservedAt is
// "when nocx last saw it", never a claim about the host right now.
//
// shell.footprint.uninstall is offered only for destinations with a
// removableProfileId (a saved connection resolves to them) — an action that
// is valid from the state the user is in. The backend owns the dial; the
// renderer never sees an SSH client.

import type { Dispatcher } from './dispatcher'
import type { ShellFootprintStatusResult } from './generated/shell.footprint.status'
import type { ShellFootprintUninstallResult } from './generated/shell.footprint.uninstall'

export class FootprintClient {
  constructor(private dispatcher: Dispatcher) {}

  /** Every destination nocx has an installed fact for: what was written,
   *  where (~/.nocx), when last seen, and which saved connection (if any)
   *  can remove it. Empty list = nothing ever observed installed. */
  status(): Promise<ShellFootprintStatusResult> {
    return this.dispatcher.call<ShellFootprintStatusResult>('shell.footprint.status', {})
  }

  /** Remove the integration bundle on the host a saved connection reaches.
   *  Only manifest-owned, unmodified files are removed; the result names
   *  both lists — removed and conflicts (files the user changed, left in
   *  place). */
  uninstall(profileId: string): Promise<ShellFootprintUninstallResult> {
    return this.dispatcher.call<ShellFootprintUninstallResult>('shell.footprint.uninstall', {
      profileId,
    })
  }
}
