// ═══════════════════════════════════════════════════════════════════════════
// ConnectionsContent — wraps the SSH connection manager as a TabContent.
// Migrated from the old Tab.managerView escape hatch (B.4).
// ═══════════════════════════════════════════════════════════════════════════

import { ConnectionManagerViewImpl } from './connections'
import type { ProfileClient, SSHProfile } from './profiles'
import type { TabHost, TabContent, ContentViewport } from './tab-content'

export class ConnectionsContent implements TabContent {
  private view: ConnectionManagerViewImpl | null = null
  private _target: HTMLElement | null = null

  private _disposed = false

  constructor(private readonly profileClient: ProfileClient) {}

  /** Callback for when the user clicks Connect on a profile. */
  onConnect?: (profile: SSHProfile) => void

  async mount(target: HTMLElement, host: TabHost, signal: AbortSignal): Promise<void> {
    if (this._disposed || this.view) return
    this._target = target

    if (signal.aborted) return

    const view = new ConnectionManagerViewImpl(target, this.profileClient)
    view.onConnect = (profile: SSHProfile) => {
      this.onConnect?.(profile)
    }
    this.view = view

    host.setTitle('Connections')

    view.show()
    await view.refresh()
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  viewportChanged(_viewport: ContentViewport): void {
    // Connections view is a scrolling container — no viewport-specific
    // behaviour.
  }

  setVisible(visible: boolean): void {
    if (this._target) {
      this._target.classList.toggle('active', visible)
    }
  }

  focus(): void {
    // Connections view has no primary input to focus.
  }

  dispose(): void {
    this._disposed = true
    this.view = null
  }
}
