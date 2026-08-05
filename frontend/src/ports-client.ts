// PortsClient — the ports.* control-plane seam (nocx-wzc4.2). One client,
// four methods; the panel surface consumes it through PortsPanelServices so
// tests can substitute a fake without a WebSocket.

import type { Dispatcher } from './dispatcher'
import type { PortsStatusResult } from './generated/ports.status'
import type { PortsSampleResult } from './generated/ports.sample'
import type { PortsPauseResult } from './generated/ports.pause'
import type { PortsVisibleResult } from './generated/ports.visible'

/** The reserved ports.* target id for the machine nocx itself runs on —
 *  `discovery.LocalTargetID` in Go. A local tab scopes the ports panel to
 *  this literal, exactly like a profile id: profile ids are always
 *  `type:custom:slug:uuid`, so the bare value can never collide with a
 *  stored profile (nocx-wzc4.8). */
export const LOCAL_TARGET_ID = 'local'

export class PortsClient {
  constructor(private dispatcher: Dispatcher) {}

  /** The full status for one profile: discovery state plus tracked forwards. */
  status(profileId: string): Promise<PortsStatusResult> {
    return this.dispatcher.call<PortsStatusResult>('ports.status', { profileId })
  }

  /** Retry: clears a terminal refusal and samples immediately. Returns the
   *  fresh status, not the pre-retry one. */
  sample(profileId: string): Promise<PortsSampleResult> {
    return this.dispatcher.call<PortsSampleResult>('ports.sample', { profileId })
  }

  /** The user's Pause/Resume control. */
  pause(profileId: string, paused: boolean): Promise<PortsPauseResult> {
    return this.dispatcher.call<PortsPauseResult>('ports.pause', { profileId, paused })
  }

  /** The panel watcher's visibility: periodic sampling runs only while a
   *  watcher is visible and nothing is paused. */
  visible(profileId: string, visible: boolean): Promise<PortsVisibleResult> {
    return this.dispatcher.call<PortsVisibleResult>('ports.visible', { profileId, visible })
  }
}
