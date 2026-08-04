// ═══════════════════════════════════════════════════════════════════════════
// Ports surface registration — the seam the composition root uses to make
// the ports panel (nocx-wzc4.2) reachable. Extracted from main.tsx so both
// entry points (palette item, keybinding) are testable against a real
// TabManager: a test opens an SSH tab and dispatches the real chord, then
// asserts a 'nocx.ports' tab is on screen (AGENTS.md rule 1 — the user
// reaches the panel, the component never mounts in a vacuum).
// ═══════════════════════════════════════════════════════════════════════════

import { PortsContent, type PortsPanelServices } from './ports'
import type { SurfaceRegistry } from './surface-registry'
import type { Tab } from './tabs'
import type { TabManager } from './tabs'
import type { SurfaceType } from './tab-content'

/** Stable registry id for the ports surface. */
export const SURFACE_ID_PORTS = 'ports'

/** Branded surface type, used in restore descriptors and deep links. */
export const PORTS_SURFACE_TYPE: SurfaceType = 'nocx.ports' as SurfaceType

/** Ctrl/Cmd+Shift+O — "pOrt". Free today: P is the palette, I is integrate,
 *  V is the vault-secret picker, . is native-mode; the no-shift set is
 *  B/T/W/1-9/,/R (sidebar, TabManager, Settings, recall). The test builds
 *  its dispatched KeyboardEvent from this, so the chord cannot drift. */
export const PORTS_KEYBINDING = { key: 'o', mod: true, shift: true } as const

/** Register the ports surface and return the single entry point both UI
 *  triggers (palette item, keybinding) call.
 *
 *  The factory resolves the ACTIVE tab's profileId at build() time, not at
 *  registration: the panel is scoped to whichever connection is in front
 *  when the user opens it, and capturing the id up front would go stale.
 *  openPorts() returns null (and opens nothing) when the active tab is not
 *  a saved-profile SSH terminal — local shells and alias tabs have no
 *  profile to scope the panel to. */
export function registerPortsSurface(
  registry: SurfaceRegistry,
  services: PortsPanelServices,
  tm: TabManager,
): () => Tab | null {
  registry.register(SURFACE_ID_PORTS, {
    surfaceType: PORTS_SURFACE_TYPE,
    singletonKey: null,
    factory: () => {
      const profileId = tm.activeProfileId()
      if (profileId === null) {
        // Unreachable from openPorts() (it guards first); a future entry
        // point that skips the guard gets a loud failure, not a panel
        // scoped to nothing.
        throw new Error('nocx: ports surface opened without an active saved-profile SSH tab')
      }
      return new PortsContent(profileId, services)
    },
    descriptor: {
      restoreDescriptor: null,
      supportsAttention: false,
      defaultTitle: 'Ports',
    },
  })

  return function openPorts(): Tab | null {
    if (tm.activeProfileId() === null) return null
    const { content, descriptor } = registry.build(SURFACE_ID_PORTS)
    return tm.openTab(content, descriptor)
  }
}

/** Attach the ports keybinding. Returns a dispose function (main.tsx keeps
 *  the listener for the app's lifetime; tests dispose after each case).
 *  The chord is intercepted ONLY while the active tab is a saved-profile
 *  SSH terminal: openPorts() returns null otherwise, and the handler then
 *  leaves the event alone, so the chord stays free in the editor and
 *  everywhere else. */
export function registerPortsKeybinding(openPorts: () => Tab | null): () => void {
  const handler = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return
    // Shift is held, so the browser reports the UPPERCASE letter ('O'); the
    // same toLowerCase() normalization the vault picker uses (terminal-content
    // treats Ctrl/Cmd+Shift+V via e.key.toLowerCase()).
    if (e.key.toLowerCase() !== PORTS_KEYBINDING.key) return
    if (openPorts() === null) return
    e.preventDefault()
  }
  document.addEventListener('keydown', handler)
  return () => document.removeEventListener('keydown', handler)
}
