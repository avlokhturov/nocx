// ═══════════════════════════════════════════════════════════════════════════
// ConnectionsContent — wraps the Solid connections manager as a TabContent.
// Migrated from the imperative ConnectionManagerViewImpl (nocx-1cru).
// ═══════════════════════════════════════════════════════════════════════════

import type { ProfileClient, SSHProfile } from './profiles'
import { BaseTabContent, type TabHost, type ContentViewport } from './tab-content'
import { mountConnectionsView } from './connections'

export class ConnectionsContent extends BaseTabContent {
  private disposeSolid: (() => void) | null = null

  private _disposed = false

  constructor(private readonly profileClient: ProfileClient) {
    super()
  }

  /** Callback for when the user clicks Connect on a profile. */
  onConnect?: (profile: SSHProfile) => void

  // eslint-disable-next-line @typescript-eslint/require-await
  async mount(target: HTMLElement, host: TabHost, signal: AbortSignal): Promise<void> {
    if (this._disposed || this.disposeSolid) return

    if (signal.aborted) return

    host.setTitle('Connections')

    this.disposeSolid = mountConnectionsView(target, this.profileClient, (profile) => {
      this.onConnect?.(profile)
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  viewportChanged(_viewport: ContentViewport): void {
    // Connections view is a scrolling container — no viewport-specific
    // behaviour.
  }

  focus(): void {
    // Connections view has no primary input to focus.
  }

  dispose(): void {
    this._disposed = true
    this.disposeSolid?.()
    this.disposeSolid = null
  }
}
