// ═══════════════════════════════════════════════════════════════════════════
// SettingsContent — wraps the Solid settings component as a TabContent.
// Thin mount-once wrapper; the entire UI is the Solid component in
// settings.tsx. ExportSection is rendered as a child component inside it.
// ═══════════════════════════════════════════════════════════════════════════

import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import { type ProfileClient } from './profiles'
import { type SettingsObserver } from './settings-observer'
import { BaseTabContent, type TabHost, type ContentViewport } from './tab-content'
import type { SurfaceType, SingletonKey } from './tab-content'
import { SettingsComponent, type SettingsComponentHandle } from './settings'

// ── Registered surface constants (B.7) ─────────────────────────────────

export const SURFACE_SETTINGS: SurfaceType = 'nocx.settings' as SurfaceType
export const SINGLETON_SETTINGS: SingletonKey = 'nocx.settings' as SingletonKey

// ── Breakpoint ─────────────────────────────────────────────────────────

/** Width below which the rail stacks above the content column. */
const NARROW_BREAKPOINT_PX = 640

// ── SettingsContent ─────────────────────────────────────────────────────

export class SettingsContent extends BaseTabContent {
  private container: HTMLElement | null = null
  private _dispose: (() => void) | null = null
  private handle: SettingsComponentHandle | null = null
  private _disposed = false

  constructor(
    private readonly profileClient: ProfileClient,
    private readonly observer?: SettingsObserver,
  ) {
    super()
  }

  // ── TabContent ───────────────────────────────────────────────────────

  async mount(target: HTMLElement, host: TabHost, signal: AbortSignal): Promise<void> {
    if (this._disposed || this.container) return
    if (signal.aborted) return

    host.setTitle('Settings')

    // Create the root container that the Solid component renders into.
    const root = document.createElement('div')
    target.append(root)
    this.container = root

    // Mount the Solid component via a shared ref for cross-seam communication.
    const handleRef: { current: SettingsComponentHandle | null } = { current: null }
    this._dispose = render(
      () =>
        createComponent(SettingsComponent, {
          profileClient: this.profileClient,
          observer: this.observer,
          ref: handleRef,
        }),
      root,
    )
    this.handle = handleRef.current!
    await this.handle.ready()
  }

  focus(): void {
    this.handle?.focus()
  }

  viewportChanged(viewport: ContentViewport): void {
    const narrow = viewport.width < NARROW_BREAKPOINT_PX
    this.handle?.setNarrow(narrow)
  }

  dispose(): void {
    this._disposed = true
    this._dispose?.()
    this._dispose = null
    this.container?.remove()
    this.container = null
    this.handle = null
  }

  // ── Deep link ───────────────────────────────────────────────────────

  scrollToKey(key: string): void {
    this.handle?.scrollToKey(key)
  }
}
