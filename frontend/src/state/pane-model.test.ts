// tab-model — pure functions only, no jsdom, no Solid.
import { describe, it, expect } from 'vitest'
import {
  createPaneModel,
  addPane,
  activatePane,
  closePane,
  reorderPane,
  updatePaneTitle,
  updatePaneActivity,
  updatePaneAgentStatus,
  type PaneDescriptor,
} from './pane-model'

// ── Fixtures ───────────────────────────────────────────────────────────────

const TERMINAL_DESC: PaneDescriptor = {
  surfaceType: 'nocx.terminal',
  singletonKey: null,
  restoreDescriptor: { type: 'local' },
  supportsAttention: true,
  defaultTitle: 'Terminal',
}

const SETTINGS_DESC: PaneDescriptor = {
  surfaceType: 'nocx.settings',
  singletonKey: null,
  restoreDescriptor: { type: 'settings' },
  supportsAttention: false,
  defaultTitle: 'Settings',
}

// ── createPaneModel ─────────────────────────────────────────────────────────

describe('createPaneModel', () => {
  it('creates an empty model with no tabs', () => {
    const m = createPaneModel()
    expect(m.tabs).toEqual([])
    expect(m.activePaneId).toBeNull()
    expect(m.nextPaneId).toBe(1)
    expect(m.recentPaneIds).toEqual([])
  })
})

// ── addPane ─────────────────────────────────────────────────────────────────

describe('addPane', () => {
  it('adds a tab, assigns id, and activates it', () => {
    const m = addPane(createPaneModel(), TERMINAL_DESC)
    expect(m.tabs).toHaveLength(1)
    expect(m.tabs[0].id).toBe(1)
    expect(m.tabs[0].title).toBe('Terminal')
    expect(m.tabs[0].hasActivity).toBe(false)
    expect(m.tabs[0].agentStatus).toBeNull()
    expect(m.tabs[0].disposed).toBe(false)
    expect(m.activePaneId).toBe(1)
    expect(m.nextPaneId).toBe(2)
  })

  it('increments id for each tab', () => {
    const m1 = addPane(createPaneModel(), TERMINAL_DESC)
    const m2 = addPane(m1, SETTINGS_DESC)
    expect(m2.tabs).toHaveLength(2)
    expect(m2.tabs[0].id).toBe(1)
    expect(m2.tabs[1].id).toBe(2)
    expect(m2.nextPaneId).toBe(3)
  })

  it('activates the new tab and pushes previous to MRU', () => {
    const m1 = addPane(createPaneModel(), TERMINAL_DESC)
    const m2 = addPane(m1, SETTINGS_DESC)
    expect(m2.activePaneId).toBe(2)
    expect(m2.recentPaneIds).toEqual([1])
  })

  it('does not mutate the input model', () => {
    const m = createPaneModel()
    const next = addPane(m, TERMINAL_DESC)
    expect(m.tabs).toHaveLength(0)
    expect(next.tabs).toHaveLength(1)
  })
})

// ── activatePane ────────────────────────────────────────────────────────────

describe('activatePane', () => {
  it('switches the active tab and pushes previous to MRU', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    m = addPane(m, SETTINGS_DESC)
    expect(m.activePaneId).toBe(2)
    m = activatePane(m, 1)
    expect(m.activePaneId).toBe(1)
    expect(m.recentPaneIds).toEqual([2])
  })

  it('is a no-op when the tab is already active', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    const before = m
    m = activatePane(m, 1)
    expect(m).toBe(before)
  })

  it('is a no-op when the tab id does not exist', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    const before = m
    m = activatePane(m, 999)
    expect(m).toBe(before)
  })

  it('retains MRU order across multiple activations', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    m = addPane(m, SETTINGS_DESC)
    m = addPane(m, {
      ...TERMINAL_DESC,
      defaultTitle: 'Third',
    })
    // active: tab 3; MRU: [1, 2]
    m = activatePane(m, 1)
    // active: tab 1; MRU: [2, 3]
    m = activatePane(m, 2)
    // active: tab 2; MRU: [3, 1]
    expect(m.activePaneId).toBe(2)
    expect(m.recentPaneIds).toEqual([3, 1])
  })
})

// ── closePane ─────────────────────────────────────────────────────────────────

describe('closePane', () => {
  it('removes a tab and activates MRU fallback', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    m = addPane(m, SETTINGS_DESC)
    m = addPane(m, {
      ...TERMINAL_DESC,
      defaultTitle: 'Third',
    })
    // active: tab 3, MRU: [1, 2]
    m = closePane(m, 3)
    expect(m.tabs).toHaveLength(2)
    expect(m.activePaneId).toBe(2) // MRU: pop 2
    // Tab 2 was pushed onto MRU but remains there since we closed tab 3.
    expect(m.recentPaneIds).toEqual([1, 2])
  })

  it('creates a new terminal tab when closing the last tab', () => {
    let m = addPane(createPaneModel(), SETTINGS_DESC)
    expect(m.tabs).toHaveLength(1)
    m = closePane(m, 1)
    // Should create a fresh terminal tab (default).
    expect(m.tabs[0].descriptor.surfaceType).toBe('nocx.terminal')
    expect(m.tabs[0].title).toBe('Terminal')
  })
  it('activates MRU fallback when closing the active tab', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    m = addPane(m, SETTINGS_DESC)
    m = addPane(m, { ...TERMINAL_DESC, defaultTitle: 'Third' })
    // active: tab 3, MRU: [1, 2]
    m = closePane(m, 3)
    expect(m.activePaneId).toBe(2) // MRU pop: 2

    // Now close tab 2 (active) — fallback to MRU: 1
    m = closePane(m, 2)
    expect(m.activePaneId).toBe(1)
  })
})

// ── reorderPane ─────────────────────────────────────────────────────────────

describe('reorderPane', () => {
  it('moves a tab from one position to another', () => {
    let m = addPane(createPaneModel(), { ...TERMINAL_DESC, defaultTitle: 'A' })
    m = addPane(m, { ...TERMINAL_DESC, defaultTitle: 'B' })
    m = addPane(m, { ...TERMINAL_DESC, defaultTitle: 'C' })
    m = reorderPane(m, 1, 3)
    // order: B(2), A(1), C(3) — A goes to the position C was at (index 1
    // after removal), matching the original PaneManager.reorderPane behaviour.
    expect(m.tabs.map((t) => t.title)).toEqual(['B', 'A', 'C'])
  })
  it('is a no-op for invalid ids', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    const before = m
    m = reorderPane(m, 1, 999)
    expect(m).toBe(before)
  })
})

// ── updatePaneTitle ─────────────────────────────────────────────────────────

describe('updatePaneTitle', () => {
  it('sets the title on the matching tab', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    m = updatePaneTitle(m, 1, 'My Project')
    expect(m.tabs[0].title).toBe('My Project')
    // Other tabs unchanged.
    m = addPane(m, SETTINGS_DESC)
    m = updatePaneTitle(m, 2, 'Modified')
    expect(m.tabs[0].title).toBe('My Project')
    expect(m.tabs[1].title).toBe('Modified')
  })

  it('returns the model unchanged for unknown tab id', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    const before = m
    m = updatePaneTitle(m, 999, 'Nope')
    expect(m).toBe(before)
  })
})

// ── updatePaneActivity ──────────────────────────────────────────────────────

describe('updatePaneActivity', () => {
  it('sets the activity flag on the matching tab', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    expect(m.tabs[0].hasActivity).toBe(false)
    m = updatePaneActivity(m, 1, true)
    expect(m.tabs[0].hasActivity).toBe(true)
  })

  it('returns the model unchanged for unknown tab id', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    const before = m
    m = updatePaneActivity(m, 999, true)
    expect(m).toBe(before)
  })
})

// ── updatePaneAgentStatus ───────────────────────────────────────────────────

describe('updatePaneAgentStatus', () => {
  it('sets the agent status on the matching tab', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    expect(m.tabs[0].agentStatus).toBeNull()
    m = updatePaneAgentStatus(m, 1, 'working')
    expect(m.tabs[0].agentStatus).toBe('working')
  })

  it('clears the agent status', () => {
    let m = addPane(createPaneModel(), TERMINAL_DESC)
    m = updatePaneAgentStatus(m, 1, 'working')
    m = updatePaneAgentStatus(m, 1, null)
    expect(m.tabs[0].agentStatus).toBeNull()
  })
})

// ── Immutability ───────────────────────────────────────────────────────────

describe('immutability', () => {
  it('transition functions do not mutate the input', () => {
    const m1 = addPane(createPaneModel(), TERMINAL_DESC)
    const m2 = addPane(m1, SETTINGS_DESC)
    expect(m1.tabs).toHaveLength(1)

    const m3 = closePane(m2, 2)
    expect(m2.tabs).toHaveLength(2)
    expect(m3.tabs).toHaveLength(1)

    updatePaneTitle(m1, 1, 'Changed')
    expect(m1.tabs[0].title).toBe('Terminal')
  })
})
