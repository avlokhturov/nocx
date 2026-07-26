// ═══════════════════════════════════════════════════════════════════════════
// SurfaceRegistry — single declaration of every tab-surface's type, key,
// descriptor, and factory. The composition root registers a surface once;
// every entry point (sidebar, keyboard shortcut, deep link) resolves
// through the registry rather than rebuilding the same descriptor.
//
// AD-8 corollary: a registry whose consumers switch on the surface type is
// the anti-pattern. Consumers look up by a stable id and receive a fully-
// formed ContentDescriptor — there is no "type" field to branch on.
// ═══════════════════════════════════════════════════════════════════════════

import type { TabContent, ContentDescriptor, SurfaceType, SingletonKey } from './tab-content'

// ── Registration ──────────────────────────────────────────────────────────

export interface SurfaceRegistration {
  /** Branded surface type used in restore descriptors and deep links. */
  readonly surfaceType: SurfaceType

  /** Singleton key for content types that allow at most one open tab. */
  readonly singletonKey: SingletonKey | null

  /** Factory that creates a new TabContent instance. Called each time
   *  a consumer opens the surface, so the singleton guarantee must come
   *  from TabManager.openTab's singletonKey dedup, not from caching here. */
  readonly factory: () => TabContent

  /** Descriptor fields that are not surfaceType or singletonKey — those
   *  are pulled from the registration above so they are never duplicated. */
  readonly descriptor: Omit<ContentDescriptor, 'surfaceType' | 'singletonKey'>
}

// ── Registry ──────────────────────────────────────────────────────────────

export class SurfaceRegistry {
  private readonly entries = new Map<string, SurfaceRegistration>()

  /** Register a surface under a stable id. Overwrites an existing entry. */
  register(id: string, registration: SurfaceRegistration): void {
    this.entries.set(id, registration)
  }

  /** Look up a registration by id. Returns undefined if not registered. */
  get(id: string): SurfaceRegistration | undefined {
    return this.entries.get(id)
  }

  /** Build a full ContentDescriptor and a fresh TabContent instance
   *  for opening a surface. Returns undefined if the id is not registered. */
  build(id: string): { content: TabContent; descriptor: ContentDescriptor } | undefined {
    const reg = this.entries.get(id)
    if (!reg) return undefined
    return {
      content: reg.factory(),
      descriptor: {
        surfaceType: reg.surfaceType,
        singletonKey: reg.singletonKey,
        ...reg.descriptor,
      },
    }
  }
}
