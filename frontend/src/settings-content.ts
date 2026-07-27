// ═══════════════════════════════════════════════════════════════════════════
// SettingsContent — wraps the Solid settings component as a TabContent.
// Thin adapter over SolidTabContent; keeps existing public behaviour
// (focus, scrollToKey, narrow-breakpoint handling). The entire UI is the
// Solid component in settings.tsx. ExportSection is rendered as a child
// component inside it.
// ═══════════════════════════════════════════════════════════════════════════

import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import { type ProfileClient } from './profiles'
import { type SettingsObserver } from './settings-observer'
import { SolidTabContent, type TabHost, type ContentViewport } from './solid-tab-content'
import type { SurfaceType, SingletonKey } from './tab-content'
import { SettingsComponent, type SettingsComponentHandle } from './settings'

// ── Registered surface constants (B.7) ─────────────────────────────────

export const SURFACE_SETTINGS: SurfaceType = 'nocx.settings' as SurfaceType
export const SINGLETON_SETTINGS: SingletonKey = 'nocx.settings' as SingletonKey

// ── Breakpoint ─────────────────────────────────────────────────────────

/** Width below which the rail stacks above the content column. */
const NARROW_BREAKPOINT_PX = 640

// ── SettingsContent ─────────────────────────────────────────────────────

export class SettingsContent extends SolidTabContent {
  private handleRef: { current: SettingsComponentHandle | null } = { current: null }
  private handle: SettingsComponentHandle | null = null

  constructor(
    private readonly profileClient: ProfileClient,
    private readonly observer?: SettingsObserver,
  ) {
    super()
  }

  renderContent(root: HTMLElement): () => void {
    return render(
      () =>
        createComponent(SettingsComponent, {
          profileClient: this.profileClient,
          observer: this.observer,
          ref: this.handleRef,
        }),
      root,
    )
  }

  // ── TabContent ───────────────────────────────────────────────────────

  async mount(target: HTMLElement, host: TabHost, signal: AbortSignal): Promise<void> {
    if (this._disposed || this._hostElement) return
    if (signal.aborted) return

    host.setTitle('Settings')
    await super.mount(target, host, signal)
    this.handle = this.handleRef.current!
    await this.handle.ready()
  }

  focus(): void {
    this.handle?.focus()
  }

  viewportChanged(viewport: ContentViewport): void {
    const narrow = viewport.width < NARROW_BREAKPOINT_PX
    this.handle?.setNarrow(narrow)
  }

  // dispose() inherited from SolidTabContent — it tears down the root
  // element and Solid root. The handle reference becomes stale naturally
  // as the component disposes.

  // ── Deep link ───────────────────────────────────────────────────────

  scrollToKey(key: string): void {
    this.handle?.scrollToKey(key)
  }
}
