// tab-model — pure functions only, no jsdom, no Solid.
import { describe, it, expect } from 'vitest'
import {
  createTabModel,
  addTab,
  activateTab,
  closeTab,
  reorderTab,
  updateTabTitle,
  updateTabActivity,
  updateTabAgentStatus,
  type TabDescriptor,
} from './tab-model'

// ── Fixtures ───────────────────────────────────────────────────────────────

const TERMINAL_DESC: TabDescriptor = {
  surfaceType: 'nocx.terminal',
  singletonKey: null,
  restoreDescriptor: { type: 'local' },
  supportsAttention: true,
  defaultTitle: 'Terminal',
}

const SETTINGS_DESC: TabDescriptor = {
  surfaceType: 'nocx.settings',
  singletonKey: null,
  restoreDescriptor: { type: 'settings' },
  supportsAttention: false,
  defaultTitle: 'Settings',
}

// ── createTabModel ─────────────────────────────────────────────────────────

describe('createTabModel', () => {
  it('creates an empty model with no tabs', () => {
    const m = createTabModel()
    expect(m.tabs).toEqual([])
    expect(m.activeTabId).toBeNull()
    expect(m.nextTabId).toBe(1)
    expect(m.recentTabIds).toEqual([])
  })
})

// ── addTab ─────────────────────────────────────────────────────────────────

describe('addTab', () => {
  it('adds a tab, assigns id, and activates it', () => {
    const m = addTab(createTabModel(), TERMINAL_DESC)
    expect(m.tabs).toHaveLength(1)
    expect(m.tabs[0].id).toBe(1)
    expect(m.tabs[0].title).toBe('Terminal')
    expect(m.tabs[0].hasActivity).toBe(false)
    expect(m.tabs[0].agentStatus).toBeNull()
    expect(m.tabs[0].disposed).toBe(false)
    expect(m.activeTabId).toBe(1)
    expect(m.nextTabId).toBe(2)
  })

  it('increments id for each tab', () => {
    const m1 = addTab(createTabModel(), TERMINAL_DESC)
    const m2 = addTab(m1, SETTINGS_DESC)
    expect(m2.tabs).toHaveLength(2)
    expect(m2.tabs[0].id).toBe(1)
    expect(m2.tabs[1].id).toBe(2)
    expect(m2.nextTabId).toBe(3)
  })

  it('activates the new tab and pushes previous to MRU', () => {
    const m1 = addTab(createTabModel(), TERMINAL_DESC)
    const m2 = addTab(m1, SETTINGS_DESC)
    expect(m2.activeTabId).toBe(2)
    expect(m2.recentTabIds).toEqual([1])
  })

  it('does not mutate the input model', () => {
    const m = createTabModel()
    const next = addTab(m, TERMINAL_DESC)
    expect(m.tabs).toHaveLength(0)
    expect(next.tabs).toHaveLength(1)
  })
})

// ── activateTab ────────────────────────────────────────────────────────────

describe('activateTab', () => {
  it('switches the active tab and pushes previous to MRU', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    m = addTab(m, SETTINGS_DESC)
    expect(m.activeTabId).toBe(2)
    m = activateTab(m, 1)
    expect(m.activeTabId).toBe(1)
    expect(m.recentTabIds).toEqual([2])
  })

  it('is a no-op when the tab is already active', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    const before = m
    m = activateTab(m, 1)
    expect(m).toBe(before)
  })

  it('is a no-op when the tab id does not exist', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    const before = m
    m = activateTab(m, 999)
    expect(m).toBe(before)
  })

  it('retains MRU order across multiple activations', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    m = addTab(m, SETTINGS_DESC)
    m = addTab(m, {
      ...TERMINAL_DESC,
      defaultTitle: 'Third',
    })
    // active: tab 3; MRU: [1, 2]
    m = activateTab(m, 1)
    // active: tab 1; MRU: [2, 3]
    m = activateTab(m, 2)
    // active: tab 2; MRU: [3, 1]
    expect(m.activeTabId).toBe(2)
    expect(m.recentTabIds).toEqual([3, 1])
  })
})

// ── closeTab ─────────────────────────────────────────────────────────────────

describe('closeTab', () => {
  it('removes a tab and activates MRU fallback', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    m = addTab(m, SETTINGS_DESC)
    m = addTab(m, {
      ...TERMINAL_DESC,
      defaultTitle: 'Third',
    })
    // active: tab 3, MRU: [1, 2]
    m = closeTab(m, 3)
    expect(m.tabs).toHaveLength(2)
    expect(m.activeTabId).toBe(2) // MRU: pop 2
    // Tab 2 was pushed onto MRU but remains there since we closed tab 3.
    expect(m.recentTabIds).toEqual([1, 2])
  })

  it('creates a new terminal tab when closing the last tab', () => {
    let m = addTab(createTabModel(), SETTINGS_DESC)
    expect(m.tabs).toHaveLength(1)
    m = closeTab(m, 1)
    // Should create a fresh terminal tab (default).
    expect(m.tabs[0].descriptor.surfaceType).toBe('nocx.terminal')
    expect(m.tabs[0].title).toBe('Terminal')
  })
  it('activates MRU fallback when closing the active tab', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    m = addTab(m, SETTINGS_DESC)
    m = addTab(m, { ...TERMINAL_DESC, defaultTitle: 'Third' })
    // active: tab 3, MRU: [1, 2]
    m = closeTab(m, 3)
    expect(m.activeTabId).toBe(2) // MRU pop: 2

    // Now close tab 2 (active) — fallback to MRU: 1
    m = closeTab(m, 2)
    expect(m.activeTabId).toBe(1)
  })
})

// ── reorderTab ─────────────────────────────────────────────────────────────

describe('reorderTab', () => {
  it('moves a tab from one position to another', () => {
    let m = addTab(createTabModel(), { ...TERMINAL_DESC, defaultTitle: 'A' })
    m = addTab(m, { ...TERMINAL_DESC, defaultTitle: 'B' })
    m = addTab(m, { ...TERMINAL_DESC, defaultTitle: 'C' })
    m = reorderTab(m, 1, 3)
    // order: B(2), A(1), C(3) — A goes to the position C was at (index 1
    // after removal), matching the original TabManager.reorderTab behaviour.
    expect(m.tabs.map((t) => t.title)).toEqual(['B', 'A', 'C'])
  })
  it('is a no-op for invalid ids', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    const before = m
    m = reorderTab(m, 1, 999)
    expect(m).toBe(before)
  })
})

// ── updateTabTitle ─────────────────────────────────────────────────────────

describe('updateTabTitle', () => {
  it('sets the title on the matching tab', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    m = updateTabTitle(m, 1, 'My Project')
    expect(m.tabs[0].title).toBe('My Project')
    // Other tabs unchanged.
    m = addTab(m, SETTINGS_DESC)
    m = updateTabTitle(m, 2, 'Modified')
    expect(m.tabs[0].title).toBe('My Project')
    expect(m.tabs[1].title).toBe('Modified')
  })

  it('returns the model unchanged for unknown tab id', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    const before = m
    m = updateTabTitle(m, 999, 'Nope')
    expect(m).toBe(before)
  })
})

// ── updateTabActivity ──────────────────────────────────────────────────────

describe('updateTabActivity', () => {
  it('sets the activity flag on the matching tab', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    expect(m.tabs[0].hasActivity).toBe(false)
    m = updateTabActivity(m, 1, true)
    expect(m.tabs[0].hasActivity).toBe(true)
  })

  it('returns the model unchanged for unknown tab id', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    const before = m
    m = updateTabActivity(m, 999, true)
    expect(m).toBe(before)
  })
})

// ── updateTabAgentStatus ───────────────────────────────────────────────────

describe('updateTabAgentStatus', () => {
  it('sets the agent status on the matching tab', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    expect(m.tabs[0].agentStatus).toBeNull()
    m = updateTabAgentStatus(m, 1, 'working')
    expect(m.tabs[0].agentStatus).toBe('working')
  })

  it('clears the agent status', () => {
    let m = addTab(createTabModel(), TERMINAL_DESC)
    m = updateTabAgentStatus(m, 1, 'working')
    m = updateTabAgentStatus(m, 1, null)
    expect(m.tabs[0].agentStatus).toBeNull()
  })
})

// ── Immutability ───────────────────────────────────────────────────────────

describe('immutability', () => {
  it('transition functions do not mutate the input', () => {
    const m1 = addTab(createTabModel(), TERMINAL_DESC)
    const m2 = addTab(m1, SETTINGS_DESC)
    expect(m1.tabs).toHaveLength(1)

    const m3 = closeTab(m2, 2)
    expect(m2.tabs).toHaveLength(2)
    expect(m3.tabs).toHaveLength(1)

    updateTabTitle(m1, 1, 'Changed')
    expect(m1.tabs[0].title).toBe('Terminal')
  })
})
