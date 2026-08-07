// @vitest-environment jsdom
//
// openGitDiff tests: one tab per {toplevel, side, path} — the same triple
// focuses one tab while the staged and unstaged diffs of one file are two
// tabs, and two worktrees of one repository are two tabs — plus the
// frozen-origin contract through a REAL TabManager: activating a diff tab
// answers the click-time origin (never null), which is what keeps an
// origin-following panel's binding alive. A real TabManager is used — the
// dedup lives in TabManager.openTab, and asserting it through a fake would
// test the fake.
import { describe, expect, it, vi } from 'vitest'
import { createRendererMock, mountTabManager } from '../../test-support/tabs-fixtures'
import { SurfaceRegistry } from '../../surface-registry'
import type { ActiveOrigin } from '../../tab-content'
import {
  registerGitDiffSurface,
  openGitDiff,
  type GitDiffDeps,
  type GitDiffTarget,
} from './open-git-diff'

vi.mock('../../renderers/xterm', () => ({
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
  readonly calls: Array<{ bindingId: string; path: string; side: string; maxBytes: number }> = []
  readonly deps: GitDiffDeps = {
    diff: (params) => {
      this.calls.push(params)
      return Promise.resolve({ state: 'ok', text: 'x', truncated: false })
    },
    onBindingLiveness: (_bindingId, cb) => {
      cb(true)
      return () => {}
    },
    onDiffStale: () => () => {},
  }
}

const FROZEN_ORIGIN: Omit<ActiveOrigin, 'tabId'> = {
  sessionId: 'sess-1',
  kind: 'local',
  cwd: '/repo',
  cwdVerified: true,
  cwdFollow: false,
  host: null,
}

function target(overrides: Partial<GitDiffTarget>): GitDiffTarget {
  return {
    bindingId: 'b1',
    toplevel: '/repo',
    path: 'src/a.ts',
    side: 'unstaged',
    origin: FROZEN_ORIGIN,
    ...overrides,
  }
}

async function setup(): Promise<{ binding: FakeBinding; titles: () => string[] }> {
  const { manager, bar } = await mountTabManager()
  const binding = new FakeBinding()
  registerGitDiffSurface(new SurfaceRegistry(), manager, binding.deps)
  const titles = (): string[] =>
    Array.from(bar.querySelectorAll('.nocx-tab-title')).map((el) => el.textContent ?? '')
  return { binding, titles }
}

describe('openGitDiff — one tab per {toplevel, side, path}', () => {
  it('opening the same triple twice activates one tab and reads once', async () => {
    const { binding, titles } = await setup()

    openGitDiff(target({}))
    await Promise.resolve()
    openGitDiff(target({}))
    await Promise.resolve()

    expect(titles().filter((t) => t === 'src/a.ts (unstaged)')).toHaveLength(1)
    // The second open activated the existing tab; the content it built was
    // discarded before mount, so it never read.
    expect(binding.calls).toHaveLength(1)
  })

  it('the staged and unstaged diffs of one file are two tabs', async () => {
    const { binding, titles } = await setup()

    openGitDiff(target({ side: 'staged' }))
    await Promise.resolve()
    openGitDiff(target({ side: 'unstaged' }))
    await Promise.resolve()

    expect(titles()).toContain('src/a.ts (staged)')
    expect(titles()).toContain('src/a.ts (unstaged)')
    expect(binding.calls).toHaveLength(2)
  })

  it('two worktrees of one repository are two tabs', async () => {
    const { binding, titles } = await setup()

    openGitDiff(target({ toplevel: '/repo-a' }))
    await Promise.resolve()
    openGitDiff(target({ toplevel: '/repo-b' }))
    await Promise.resolve()
    const all = titles()
    // Two tabs, same visible title (the dedup key carries the toplevel):
    // the bar also holds the initial terminal tab.
    expect(all.filter((t) => t === 'src/a.ts (unstaged)')).toHaveLength(2)
    expect(binding.calls).toHaveLength(2)
  })

  it('the untracked side is its own tab too', async () => {
    const { binding, titles } = await setup()

    openGitDiff(target({ side: 'untracked' }))
    await Promise.resolve()

    expect(titles()).toContain('src/a.ts (untracked)')
    expect(binding.calls).toHaveLength(1)
  })
})

describe('openGitDiff — the frozen origin survives activation (design §5.4)', () => {
  it('a diff tab in front answers the click-time origin, never null', async () => {
    const { manager } = await mountTabManager()
    const binding = new FakeBinding()
    registerGitDiffSurface(new SurfaceRegistry(), manager, binding.deps)

    // The terminal's origin before the diff tab exists.
    const terminalOrigin = manager.activeOrigin()
    expect(terminalOrigin).not.toBeNull()

    openGitDiff(target({ origin: { ...FROZEN_ORIGIN, sessionId: terminalOrigin!.sessionId } }))
    await Promise.resolve()
    await Promise.resolve()

    // The active tab is the diff tab and it answers the frozen origin with
    // the tab id TabManager adds. If it answered null instead, the
    // origin-following panels would drop to their empty state and close the
    // very binding this tab reads through (the singletonKey would then focus
    // a dead tab forever).
    const diffOrigin = manager.activeOrigin()
    expect(diffOrigin).not.toBeNull()
    // tabId is asserted separately rather than through expect.any inside the
    // object literal: that helper is typed `any`, and spreading it here trips
    // no-unsafe-assignment for a shape the test already knows exactly.
    expect(typeof diffOrigin?.tabId).toBe('number')
    const withoutTabId = { ...diffOrigin }
    delete (withoutTabId as { tabId?: number }).tabId
    expect(withoutTabId).toEqual({
      ...FROZEN_ORIGIN,
      sessionId: terminalOrigin!.sessionId,
    })
    // The frozen origin never says where we are now.
    expect(diffOrigin?.cwdFollow).toBe(false)

    // Switching back to the terminal restores the terminal's origin.
    manager.activateByIndex(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.activeOrigin()).toEqual(terminalOrigin)
  })
})
