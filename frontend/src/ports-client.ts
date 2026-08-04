// PortsClient — the ports.* control-plane seam (nocx-wzc4.2). One client,
// four methods; the panel surface consumes it through PortsPanelServices so
// tests can substitute a fake without a WebSocket.

import type { Dispatcher } from './dispatcher'
import type { PortsStatusResult } from './generated/ports.status'
import type { PortsSampleResult } from './generated/ports.sample'
import type { PortsPauseResult } from './generated/ports.pause'
import type { PortsVisibleResult } from './generated/ports.visible'

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
