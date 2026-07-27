// ═══════════════════════════════════════════════════════════════════════════
// ConnectionsContent — wraps the Solid connections manager as a TabContent.
// Thin adapter over SolidTabContent; keeps existing public behaviour
// (onConnect). Migrated from the imperative ConnectionManagerViewImpl
// (nocx-1cru).
// ═══════════════════════════════════════════════════════════════════════════

import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import type { ProfileClient, SSHProfile } from './profiles'
import { SolidTabContent, type TabHost, type ContentViewport } from './solid-tab-content'
import { ConnectionsView } from './connections'

export class ConnectionsContent extends SolidTabContent {
  constructor(private readonly profileClient: ProfileClient) {
    super()
  }

  /** Callback for when the user clicks Connect on a profile. */
  onConnect?: (profile: SSHProfile) => void

  renderContent(root: HTMLElement): () => void {
    return render(
      () =>
        createComponent(ConnectionsView, {
          client: this.profileClient,
          onConnect: (profile: SSHProfile) => {
            this.onConnect?.(profile)
          },
        }),
      root,
    )
  }

  mount(target: HTMLElement, host: TabHost, signal: AbortSignal): Promise<void> {
    if (this._disposed || this._hostElement) return Promise.resolve()
    if (signal.aborted) return Promise.resolve()

    host.setTitle('Connections')
    return super.mount(target, host, signal)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  viewportChanged(_viewport: ContentViewport): void {
    // Connections view is a scrolling container — no viewport-specific
    // behaviour.
  }

  focus(): void {
    // Connections view has no primary input to focus.
  }
}
