// @vitest-environment jsdom
//
// openFileViewer tests: deduplication on the canonical path (D12), the
// asymmetric title rule (remote carries the host, local never does), and the
// per-endpoint key composition. A real TabManager is used — the dedup lives
// in TabManager.openTab, and asserting it through a fake would test the fake.
import { describe, expect, it, vi } from 'vitest'
import { createRendererMock, mountTabManager } from '../test-support/tabs-fixtures'
import type { FilesReadResult } from '../generated/files.read'
import { SurfaceRegistry } from '../surface-registry'
import {
  registerFileViewerSurface,
  openFileViewer,
  type FileViewerDeps,
  type FileViewerTarget,
} from './index'

vi.mock('../renderers/xterm', () => ({
  XtermRenderer: vi.fn(createRendererMock),
}))

// jsdom lacks matchMedia, which the terminal's mount path touches during
// initial-tab startup (see renderers/xterm.test.ts for the same stub).
window.matchMedia = (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList
class FakeBinding {
  readonly calls: Array<{ bindingId: string; path: string }> = []
  readonly deps: FileViewerDeps = {
    readFile: (params) => {
      this.calls.push(params)
      return Promise.resolve(okResult(params.path))
    },
    onBindingLiveness: (_bindingId, cb) => {
      cb(true)
      return () => {}
    },
  }
}

function okResult(path: string): FilesReadResult {
  return {
    path,
    canonical: path,
    text: 'x',
    size: 1,
    modTime: '2026-08-06T00:00:00Z',
    truncated: false,
    binary: false,
    lossy: false,
    changed: false,
  }
}

function target(overrides: Partial<FileViewerTarget>): FileViewerTarget {
  return {
    bindingId: 'b1',
    endpointId: 'ep1',
    path: '/srv/etc/nginx.conf',
    canonical: '/srv/etc/nginx.conf',
    displayHost: 'srv-01',
    name: 'nginx.conf',
    ...overrides,
  }
}

async function setup(): Promise<{ binding: FakeBinding; titles: () => string[] }> {
  const { manager, bar } = await mountTabManager()
  const binding = new FakeBinding()
  registerFileViewerSurface(new SurfaceRegistry(), manager, binding.deps)
  const titles = (): string[] =>
    Array.from(bar.querySelectorAll('.nocx-tab-title')).map((el) => el.textContent ?? '')
  return { binding, titles }
}

describe('openFileViewer — one tab per canonical file', () => {
  it('opening the same canonical path twice activates one tab and reads once', async () => {
    const { binding, titles } = await setup()

    openFileViewer(target({}))
    await Promise.resolve()
    openFileViewer(target({}))
    await Promise.resolve()

    expect(titles().filter((t) => t === 'srv-01 · nginx.conf')).toHaveLength(1)
    // The second open activated the existing tab; the content it built was
    // discarded before mount, so it never read.
    expect(binding.calls).toHaveLength(1)
  })

  it('two lexical paths that share a canonical path are one tab', async () => {
    const { binding, titles } = await setup()

    // /etc/nginx.conf -> /usr/local/etc/nginx.conf via symlink: one file.
    openFileViewer(target({ path: '/etc/nginx.conf', name: 'nginx.conf' }))
    await Promise.resolve()
    openFileViewer(target({ path: '/usr/local/etc/nginx.conf', name: 'nginx.conf' }))
    await Promise.resolve()

    expect(titles().filter((t) => t.includes('nginx.conf'))).toHaveLength(1)
    expect(binding.calls).toHaveLength(1)
  })

  it('the same canonical path on a different endpoint is a different tab', async () => {
    const { binding, titles } = await setup()

    openFileViewer(target({ endpointId: 'ep1', displayHost: 'srv-01' }))
    await Promise.resolve()
    openFileViewer(target({ endpointId: 'ep2', displayHost: 'srv-02' }))
    await Promise.resolve()

    expect(titles()).toContain('srv-01 · nginx.conf')
    expect(titles()).toContain('srv-02 · nginx.conf')
    expect(binding.calls).toHaveLength(2)
  })

  it('local and remote files with the same name are separate tabs', async () => {
    const { titles } = await setup()

    openFileViewer(target({ endpointId: null, displayHost: null }))
    await Promise.resolve()
    openFileViewer(target({ endpointId: 'ep1', displayHost: 'srv-01' }))
    await Promise.resolve()

    expect(titles()).toContain('nginx.conf')
    expect(titles()).toContain('srv-01 · nginx.conf')
  })
})

describe('openFileViewer — titles carry provenance asymmetrically', () => {
  it('a remote file is "host · name"; a local file is the basename alone', async () => {
    const { titles } = await setup()

    openFileViewer(target({ displayHost: 'srv-01', name: 'nginx.conf' }))
    await Promise.resolve()
    openFileViewer(
      target({
        endpointId: null,
        displayHost: null,
        path: '/etc/hosts',
        canonical: '/etc/hosts',
        name: 'hosts',
      }),
    )
    await Promise.resolve()

    const all = titles()
    // Both assertions, because the local case is the one that silently rots:
    // a marker spent on local ("local · hosts") teaches nobody which machine
    // a file is on, because every machine is local to someone.
    expect(all).toContain('srv-01 · nginx.conf')
    expect(all).toContain('hosts')
    expect(all.some((t) => t.includes('·'))).toBe(true)
    expect(all.filter((t) => t === 'hosts').length).toBe(1)
  })
})
