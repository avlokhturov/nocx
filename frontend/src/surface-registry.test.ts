// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { SurfaceRegistry } from './surface-registry'
import { BaseTabContent, type SurfaceType, type SingletonKey } from './tab-content'

// ── Surface that carries no baggage — confirms the registry works on its own ──

class StubContent extends BaseTabContent {
  async mount(): Promise<void> {
    /* no-op */
  }
  focus(): void {
    /* no-op */
  }
  viewportChanged(): void {
    /* no-op */
  }
  dispose(): void {
    /* no-op */
  }
}

const TEST_SURFACE = 'test.surface' as SurfaceType
const TEST_SINGLETON = 'test.singleton' as SingletonKey

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SurfaceRegistry', () => {
  it('builds a surface from a registration', () => {
    const registry = new SurfaceRegistry()
    registry.register('settings', {
      surfaceType: TEST_SURFACE,
      singletonKey: TEST_SINGLETON,
      factory: () => new StubContent(),
      descriptor: {
        restoreDescriptor: null,
        supportsAttention: false,
        defaultTitle: 'Settings',
      },
    })

    const built = registry.build('settings')
    expect(built).toBeDefined()
    expect(built!.descriptor.surfaceType).toBe(TEST_SURFACE)
    expect(built!.descriptor.singletonKey).toBe(TEST_SINGLETON)
    expect(built!.descriptor.restoreDescriptor).toBeNull()
    expect(built!.descriptor.supportsAttention).toBe(false)
    expect(built!.descriptor.defaultTitle).toBe('Settings')
    expect(built!.content).toBeInstanceOf(StubContent)
  })

  it('returns undefined for an unregistered surface', () => {
    const registry = new SurfaceRegistry()
    expect(registry.build('nonexistent')).toBeUndefined()
  })

  it('each build() call produces a fresh content instance', () => {
    const registry = new SurfaceRegistry()
    registry.register('multi', {
      surfaceType: TEST_SURFACE,
      singletonKey: null,
      factory: () => new StubContent(),
      descriptor: {
        restoreDescriptor: null,
        supportsAttention: false,
        defaultTitle: 'Multi',
      },
    })

    const a = registry.build('multi')
    const b = registry.build('multi')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.content).not.toBe(b!.content)
  })

  it('overriding a registration replaces the factory and descriptor', () => {
    const registry = new SurfaceRegistry()
    registry.register('over', {
      surfaceType: TEST_SURFACE,
      singletonKey: TEST_SINGLETON,
      factory: () => new StubContent(),
      descriptor: {
        restoreDescriptor: null,
        supportsAttention: false,
        defaultTitle: 'Original',
      },
    })
    registry.register('over', {
      surfaceType: TEST_SURFACE,
      singletonKey: null,
      factory: () => new StubContent(),
      descriptor: {
        restoreDescriptor: null,
        supportsAttention: true,
        defaultTitle: 'Replaced',
      },
    })

    const built = registry.build('over')
    expect(built!.descriptor.defaultTitle).toBe('Replaced')
    expect(built!.descriptor.supportsAttention).toBe(true)
    expect(built!.descriptor.singletonKey).toBeNull()
  })
})
