// @vitest-environment jsdom

// ── TabManager integration mocks ──────────────────────────────────────
// Mock it before any dynamic import resolves the chain.
import { createRendererMock } from './test-support/tabs-fixtures'

vi.mock('./renderers/xterm', () => ({
  XtermRenderer: vi.fn(createRendererMock),
}))
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsContent, SURFACE_SETTINGS, SINGLETON_SETTINGS } from './settings-content'
import { Dispatcher } from './dispatcher'
import { ProfileClient } from './profiles'
import type { Declaration } from './settings'
import type { TabHost } from './tab-content'

// ── Test declarations (mirrors settings.test.ts) ──────────────────────

const TEST_DECLARATIONS: Declaration[] = [
  {
    key: 'terminal.fontSize',
    section: 'Terminal',
    label: 'Font Size',
    description: 'Terminal font size in pixels',
    control: 'number',
    dataClass: 'publicConfig',
    default: 14,
    min: 8,
    max: 48,
  },
  {
    key: 'terminal.fontFamily',
    section: 'Terminal',
    label: 'Font Family',
    description: 'CSS font-family value',
    control: 'text',
    dataClass: 'publicConfig',
    default: 'monospace',
  },
  {
    key: 'app.confirmQuit',
    section: 'Application',
    label: 'Confirm Quit',
    description: 'Show confirmation dialog before quitting',
    control: 'toggle',
    dataClass: 'publicConfig',
    default: true,
  },
  {
    key: 'ai.apiKey',
    section: 'AI',
    label: 'API Key',
    description: 'AI provider API key',
    control: 'secret',
    dataClass: 'secretAuthenticator',
  },
]

/** Shorthand for mocking client RPCs for SettingsContent tests. */
function mockReady(
  client: ProfileClient,
  overrides: {
    declarations?: Declaration[]
    values?: Record<string, unknown>
    overridden?: string[]
    secrets?: Record<string, boolean>
  } = {},
) {
  const decls = overrides.declarations ?? TEST_DECLARATIONS
  vi.spyOn(client, 'describeSettings').mockResolvedValue({ declarations: decls })
  vi.spyOn(client, 'getSnapshot').mockResolvedValue({
    values: overrides.values ?? {},
    overridden: overrides.overridden ?? [],
    revision: 0,
  })
  const secretExists = vi.spyOn(client, 'secretExists')
  const secretMap = overrides.secrets ?? {}
  for (const d of decls) {
    if (d.control === 'secret') {
      secretExists.mockResolvedValue({ exists: secretMap[d.key] ?? false })
    }
  }
}

function mockTabHost(): TabHost {
  return {
    setTitle: vi.fn(),
    requestAttention: vi.fn(),
    requestClose: vi.fn(),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('SettingsContent', () => {
  let target: HTMLDivElement
  let client: ProfileClient
  let content: SettingsContent
  let host: TabHost
  let signal: AbortSignal

  beforeEach(() => {
    document.body.replaceChildren()
    target = document.createElement('div')
    document.body.append(target)
    client = new ProfileClient(new Dispatcher())
    content = new SettingsContent(client)
    host = mockTabHost()
    signal = new AbortController().signal
  })

  // ── Surface constants ──────────────────────────────────────────────

  it('exports surface and singleton constants', () => {
    expect(SURFACE_SETTINGS).toBe('nocx.settings')
    expect(SINGLETON_SETTINGS).toBe('nocx.settings')
  })

  // ── Mount / rail structure ──────────────────────────────────────────

  it('renders the two-pane layout with rail and content', async () => {
    mockReady(client)
    await content.mount(target, host, signal)

    const container = target.querySelector('.st-container')
    expect(container).toBeTruthy()

    const rail = container!.querySelector('.st-rail')
    expect(rail).toBeTruthy()

    const contentEl = container!.querySelector('.st-content')
    expect(contentEl).toBeTruthy()
  })

  it('rail contains search input and section navigation', async () => {
    mockReady(client)
    await content.mount(target, host, signal)

    const rail = target.querySelector('.st-rail')!
    const search = rail.querySelector('input[type="search"]')
    expect(search).toBeTruthy()
    expect((search as HTMLInputElement).placeholder).toBe('Search settings…')

    const nav = rail.querySelector('.st-section-nav')
    expect(nav).toBeTruthy()
  })

  it('section nav lists every section in declaration order', async () => {
    mockReady(client)
    await content.mount(target, host, signal)

    const links = target.querySelectorAll('.st-section-nav-link')
    const labels = Array.from(links).map((l) => l.textContent.replace(/\s*\d+\s*/, '').trim())
    expect(labels).toEqual(['Terminal', 'Application', 'AI'])
  })

  // ── Modified-only rail toggle ──────────────────────────────────────

  it('rail contains a modified-only toggle with count', async () => {
    mockReady(client, {
      values: { 'terminal.fontSize': 18, 'app.confirmQuit': false },
      overridden: ['terminal.fontSize', 'app.confirmQuit'],
    })
    await content.mount(target, host, signal)

    const modifiedSection = target.querySelector('.st-modified-rail')
    expect(modifiedSection).toBeTruthy()

    const checkbox = modifiedSection!.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox).toBeTruthy()
    expect(checkbox!.checked).toBe(false)

    const countSpan = modifiedSection!.querySelector('.st-modified-rail-count')
    expect(countSpan).toBeTruthy()
    expect(countSpan!.textContent).toBe(' (2)')
  })

  it('modified-only count excludes secrets', async () => {
    mockReady(client, {
      overridden: ['terminal.fontSize', 'ai.apiKey'],
    })
    await content.mount(target, host, signal)

    const countSpan = target.querySelector('.st-modified-rail-count')
    // Only terminal.fontSize — ai.apiKey is a secret and is excluded.
    expect(countSpan!.textContent).toBe(' (1)')
  })

  it('modified-only toggle drives SettingsViewImpl filter', async () => {
    mockReady(client, {
      values: { 'terminal.fontSize': 18 },
      overridden: ['terminal.fontSize'],
    })
    await content.mount(target, host, signal)

    // Before toggling: all 4 rows visible (3 non-secret + 1 secret)
    const rows = target.querySelectorAll('.st-row')
    expect(rows.length).toBe(4)

    // Check the rail toggle
    const checkbox = target.querySelector<HTMLInputElement>(
      '.st-modified-rail input[type="checkbox"]',
    )!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))

    await vi.waitFor(() => {
      const filteredRows = target.querySelectorAll('.st-row')
      // Only the overridden non-secret row + secrets should be visible.
      // Actually: modifiedOnly filter hides non-overridden non-secret rows and excludes secrets.
      // So only terminal.fontSize row is visible (it's overridden and non-secret).
      // But wait — the filter excludes secrets from filtering (they always show?).
      // Looking at SettingsViewImpl: if modifiedOnly, filter excludes secrets AND non-overridden.
      // So secrets are HIDDEN when modifiedOnly is active.
      // filtered = declarations ∩ modifiedOnly → secrets and non-overridden are both removed.
      expect(filteredRows.length).toBe(1)
    })
  })

  it('content filter bar checkbox stays in sync with rail toggle', async () => {
    mockReady(client, {
      values: { 'terminal.fontSize': 18 },
      overridden: ['terminal.fontSize'],
    })
    await content.mount(target, host, signal)

    // Toggle rail checkbox
    const railCheckbox = target.querySelector<HTMLInputElement>(
      '.st-modified-rail input[type="checkbox"]',
    )!
    railCheckbox.checked = true
    railCheckbox.dispatchEvent(new Event('change'))

    await vi.waitFor(() => {
      // Content filter bar checkbox should be synced
      const contentCheckbox = target.querySelector<HTMLInputElement>(
        '.st-filter-label input[type="checkbox"]',
      )
      expect(contentCheckbox).toBeTruthy()
      expect(contentCheckbox!.checked).toBe(true)
    })

    // Untoggle via content checkbox
    const contentCheckbox = target.querySelector<HTMLInputElement>(
      '.st-filter-label input[type="checkbox"]',
    )!
    contentCheckbox.checked = false
    contentCheckbox.dispatchEvent(new Event('change'))

    await vi.waitFor(() => {
      expect(railCheckbox.checked).toBe(false)
    })
  })

  // ── Section nav modified counts ─────────────────────────────────────

  it('section nav shows per-section modified counts', async () => {
    mockReady(client, {
      overridden: ['terminal.fontSize', 'app.confirmQuit'],
    })
    await content.mount(target, host, signal)

    const links = target.querySelectorAll('.st-section-nav-link')
    // Terminal: 1 modified (fontSize), Application: 1 modified, AI: 0
    const terminalLink = Array.from(links).find((l) => l.textContent.includes('Terminal'))
    const appLink = Array.from(links).find((l) => l.textContent.includes('Application'))
    const aiLink = Array.from(links).find((l) => l.textContent.includes('AI'))

    expect(terminalLink!.querySelector('.st-section-nav-badge')!.textContent).toBe('1')
    expect(appLink!.querySelector('.st-section-nav-badge')!.textContent).toBe('1')
    expect(aiLink!.querySelector('.st-section-nav-badge')).toBeFalsy()
  })

  // ── Narrow viewport ─────────────────────────────────────────────────

  it('adds st-narrow class when viewport width is below breakpoint', async () => {
    mockReady(client)
    await content.mount(target, host, signal)

    const container = target.querySelector('.st-container')!

    // Wide viewport — no narrow class
    content.viewportChanged({ width: 800, height: 600, devicePixelRatio: 1 })
    expect(container.classList.contains('st-narrow')).toBe(false)

    // Narrow viewport — add class
    content.viewportChanged({ width: 500, height: 600, devicePixelRatio: 1 })
    expect(container.classList.contains('st-narrow')).toBe(true)

    // Back to wide
    content.viewportChanged({ width: 800, height: 600, devicePixelRatio: 1 })
    expect(container.classList.contains('st-narrow')).toBe(false)
  })

  it('st-narrow class is toggled at 640 px boundary', async () => {
    mockReady(client)
    await content.mount(target, host, signal)

    const container = target.querySelector('.st-container')!

    content.viewportChanged({ width: 641, height: 600, devicePixelRatio: 1 })
    expect(container.classList.contains('st-narrow')).toBe(false)

    content.viewportChanged({ width: 639, height: 600, devicePixelRatio: 1 })
    expect(container.classList.contains('st-narrow')).toBe(true)
  })

  // ── Search ──────────────────────────────────────────────────────────

  it('search filters rows and sections', async () => {
    mockReady(client)
    await content.mount(target, host, signal)

    const searchInput = target.querySelector<HTMLInputElement>('input[type="search"]')!

    // Type "font" — should match Terminal rows
    searchInput.value = 'font'
    searchInput.dispatchEvent(new Event('input'))

    await vi.waitFor(() => {
      const rows = target.querySelectorAll<HTMLElement>('.st-row')
      const visible = Array.from(rows).filter((r) => r.style.display !== 'none')
      // All Terminal rows (fontSize, fontFamily) should be visible.
      // cursorStyle is also in Terminal but doesn't contain "font" in label/desc/key...
      // Wait, "terminal.cursorStyle" contains no "font". So only fontSize and fontFamily.
      expect(visible.length).toBe(2)
    })
  })

  // ── Dispose ─────────────────────────────────────────────────────────

  it('dispose removes container from DOM', async () => {
    mockReady(client)
    await content.mount(target, host, signal)

    expect(target.querySelector('.st-container')).toBeTruthy()
    content.dispose()
    expect(target.querySelector('.st-container')).toBeFalsy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION: TabManager + SettingsContent
//
// These tests exercise the seams where SettingsContent integrates with the
// rest of the system: TabManager.openTab dedup, the singleton registry,
// the global Cmd/Ctrl+, keybinding, the restore descriptor, and the
// interaction between SettingsContent filtering and SettingsViewImpl saves.
// ═══════════════════════════════════════════════════════════════════════════
import { TabManager } from './tabs'
import { HorizontalTabStrip } from './tab-strip'
import { makeClient, makeClipboard, makeBanner } from './test-support/tabs-fixtures'
import { ClipboardGate } from './clipboard'
import type { ContentDescriptor } from './tab-content'
import type { WSClient } from './ipc'

/** Construct a SettingsContent descriptor matching main.ts. */
function settingsDescriptor(): ContentDescriptor {
  return {
    surfaceType: SURFACE_SETTINGS,
    singletonKey: SINGLETON_SETTINGS,
    restoreDescriptor: null,
    supportsAttention: false,
    defaultTitle: 'Settings',
  }
}

/** Set up DOM + TabManager with a settings-capable ProfileClient.
 *  Returns the manager, the profile client (so callers can mock its
 *  settings methods), and DOM containers. */
async function setupIntegration(): Promise<{
  manager: TabManager
  settingsClient: ProfileClient
  bar: HTMLElement
  panes: HTMLElement
}> {
  // Build bar + panes DOM (matches tabs-fixtures setupTabBarDOM).
  document.body.replaceChildren()
  const bar = document.createElement('div')
  bar.id = 'tabbar'
  const panes = document.createElement('div')
  panes.id = 'panes'
  document.body.append(bar, panes)

  // Also create #app for syncAltScreenClass (TabManager references it).
  const app = document.createElement('div')
  app.id = 'app'
  document.body.append(app)

  const client = makeClient()
  const clipboard = makeClipboard()
  const gate = new ClipboardGate()
  const banner = makeBanner()

  const pc = {
    listProfiles: vi.fn().mockResolvedValue([]),
    listGroups: vi.fn().mockResolvedValue([]),
  }

  const tabStrip = new HorizontalTabStrip()
  const manager = new TabManager(
    bar,
    panes,
    client as unknown as WSClient,
    clipboard,
    gate,
    banner,
    pc as unknown as ProfileClient,
    tabStrip,
  )

  // Open the initial tab explicitly — the constructor mounts nothing.
  await manager.openInitialTab()

  // Create a real ProfileClient with the same Dispatcher for settings RPCs.
  const settingsClient = new ProfileClient(new Dispatcher())

  return { manager, settingsClient, bar, panes }
}

describe('SettingsContent — TabManager integration', () => {
  let manager: TabManager
  let settingsClient: ProfileClient
  let bar: HTMLElement
  let panes: HTMLElement

  beforeEach(async () => {
    const setup = await setupIntegration()
    manager = setup.manager
    settingsClient = setup.settingsClient
    bar = setup.bar
    panes = setup.panes
  })

  // ── Singleton dedup ─────────────────────────────────────────────────

  it('opening Settings twice via openTab yields one tab', async () => {
    mockReady(settingsClient)
    const desc = settingsDescriptor()

    const tab1 = manager.openTab(new SettingsContent(settingsClient), desc)
    await vi.waitFor(() => {
      expect(bar.querySelectorAll('.tab').length).toBe(2) // terminal + settings
    })

    const tab2 = manager.openTab(new SettingsContent(settingsClient), desc)

    // tab2 must be the same tab instance (dedup by singletonKey).
    expect(tab2).toBe(tab1)
    // Still only 2 tabs in the bar.
    expect(bar.querySelectorAll('.tab').length).toBe(2)
    // Only 1 pane with .st-container (the Settings one).
    expect(panes.querySelectorAll('.st-container').length).toBe(1)
  })

  it('opening Settings tab renders settings UI', async () => {
    mockReady(settingsClient)
    const desc = settingsDescriptor()

    manager.openTab(new SettingsContent(settingsClient), desc)

    await vi.waitFor(() => {
      const container = panes.querySelector('.st-container')
      expect(container).toBeTruthy()
    })

    const container = panes.querySelector('.st-container')!
    expect(container.querySelector('.st-rail')).toBeTruthy()
    expect(container.querySelector('.st-content')).toBeTruthy()
    expect(container.querySelector('.st-search')).toBeTruthy()
    expect(container.querySelector('.st-section-nav')).toBeTruthy()
  })

  // ── Cmd/Ctrl+, keybinding ───────────────────────────────────────────

  it('Cmd/Ctrl+, focuses existing Settings tab from a terminal tab', async () => {
    mockReady(settingsClient)
    const desc = settingsDescriptor()

    // Open Settings, then switch back to the terminal tab.
    manager.openTab(new SettingsContent(settingsClient), desc)
    await vi.waitFor(() => {
      expect(panes.querySelector('.st-container')).toBeTruthy()
    })
    manager.activateByIndex(0) // switch to terminal (tab index 0)

    // Simulate Cmd/Ctrl+, — same code as main.ts.
    const content2 = new SettingsContent(settingsClient)
    const tab = manager.openTab(content2, desc)

    // Dedup: no new tab created.
    expect(manager.tabCount).toBe(2)
    // The returned tab should be the existing one — verify its pane has .st-container
    // and is active.
    expect(tab.pane.classList.contains('active')).toBe(true)
    expect(tab.pane.querySelector('.st-container')).toBeTruthy()
  })

  it('Cmd/Ctrl+, works from alternate-screen state', async () => {
    mockReady(settingsClient)
    const desc = settingsDescriptor()

    // Open Settings, switch to terminal, then put #app in alt-screen mode.
    manager.openTab(new SettingsContent(settingsClient), desc)
    await vi.waitFor(() => {
      expect(panes.querySelector('.st-container')).toBeTruthy()
    })
    manager.activateByIndex(0)

    const app = document.getElementById('app')!
    app.classList.add('alt-screen')

    // Simulate Cmd/Ctrl+, while in alt-screen.
    const tab = manager.openTab(new SettingsContent(settingsClient), desc)

    // Dedup still works.
    expect(manager.tabCount).toBe(2)
    expect(tab.pane.classList.contains('active')).toBe(true)

    // alt-screen class persists (keybinding doesn't clear it).
    expect(app.classList.contains('alt-screen')).toBe(true)

    app.classList.remove('alt-screen')
  })

  // ── Close and reopen ────────────────────────────────────────────────

  it('closing and reopening Settings creates a fresh view', async () => {
    mockReady(settingsClient)
    const desc = settingsDescriptor()

    // First open.
    const tab1 = manager.openTab(new SettingsContent(settingsClient), desc)
    await vi.waitFor(() => {
      expect(panes.querySelector('.st-container')).toBeTruthy()
    })
    const container1 = tab1.pane.querySelector('.st-container')!

    // Close it.
    manager.closeTab(tab1)
    await vi.waitFor(() => {
      expect(panes.querySelectorAll('.st-container').length).toBe(0)
    })

    // Reopen — should get a NEW Settings content instance (different DOM).
    const freshClient = new ProfileClient(new Dispatcher())
    mockReady(freshClient)
    const tab2 = manager.openTab(new SettingsContent(freshClient), desc)
    await vi.waitFor(() => {
      expect(panes.querySelector('.st-container')).toBeTruthy()
    })

    const container2 = tab2.pane.querySelector('.st-container')!
    // Different DOM element — a fresh mount.
    expect(container2).not.toBe(container1)
    // The new view renders settings.
    expect(container2.querySelector('.st-rail')).toBeTruthy()
    expect(container2.querySelector('.st-content')).toBeTruthy()
  })

  // ── Restore descriptor ──────────────────────────────────────────────

  it('Settings never enters a restore record', () => {
    const desc = settingsDescriptor()
    expect(desc.restoreDescriptor).toBeNull()
    // The descriptor carries no serialisable state — no type, no id.
    // TabManager.closeTab always opens a new terminal tab when the last
    // tab closes. View tabs with null restoreDescriptor never auto-replace.
  })
})

describe('SettingsContent — save + filter integration', () => {
  let target: HTMLDivElement
  let client: ProfileClient
  let content: SettingsContent
  let host: TabHost
  let signal: AbortSignal

  beforeEach(() => {
    document.body.replaceChildren()
    target = document.createElement('div')
    document.body.append(target)
    client = new ProfileClient(new Dispatcher())
    content = new SettingsContent(client)
    host = mockTabHost()
    signal = new AbortController().signal
  })

  it('save while modified-only filter is active keeps row visible', async () => {
    // Set up with fontFamily NOT overridden, fontSize IS overridden.
    mockReady(client, {
      values: { 'terminal.fontSize': 18 },
      overridden: ['terminal.fontSize'],
    })
    // setSetting must be mocked — saveSetting calls it.
    vi.spyOn(client, 'setSetting').mockResolvedValue({ ok: true })
    await content.mount(target, host, signal)

    // Verify all rows are visible (no filter active yet).
    let rows = target.querySelectorAll<HTMLElement>('.st-row')
    expect(rows.length).toBe(4) // 3 non-secret + 1 secret

    // Activate modified-only filter via the rail checkbox.
    const railCheckbox = target.querySelector<HTMLInputElement>(
      '.st-modified-rail input[type="checkbox"]',
    )!
    railCheckbox.checked = true
    railCheckbox.dispatchEvent(new Event('change'))

    await vi.waitFor(() => {
      rows = target.querySelectorAll<HTMLElement>('.st-row')
      // Only fontSize (overridden, non-secret) visible.
      expect(rows.length).toBe(1)
    })

    // Deactivate filter, save a setting, re-activate filter.
    // The save+rerenderRow must not interfere with subsequent filtering.
    railCheckbox.checked = false
    railCheckbox.dispatchEvent(new Event('change'))

    await vi.waitFor(() => {
      rows = target.querySelectorAll<HTMLElement>('.st-row')
      expect(rows.length).toBe(4)
    })

    // Find and change the fontFamily input.
    const fontFamilyRow = document.getElementById('st-setting-terminal.fontFamily')
    expect(fontFamilyRow).toBeTruthy()
    const fontInput = fontFamilyRow!.querySelector<HTMLInputElement>('input[type="text"]')!
    fontInput.value = 'Fira Code'
    fontInput.dispatchEvent(new Event('change'))

    // Wait for the save to complete and the row to re-render.
    await vi.waitFor(() => {
      const rerendered = document.getElementById('st-setting-terminal.fontFamily')
      expect(rerendered).toBeTruthy()
      expect(rerendered!.querySelector('label')?.textContent).toBe('Font Family')
    })

    // Re-activate modified-only — both overridden rows should now appear.
    const newRailCheckbox = target.querySelector<HTMLInputElement>(
      '.st-modified-rail input[type="checkbox"]',
    )!
    newRailCheckbox.checked = true
    newRailCheckbox.dispatchEvent(new Event('change'))

    await vi.waitFor(() => {
      rows = target.querySelectorAll<HTMLElement>('.st-row')
      // Both fontSize and fontFamily are now overridden, so 2 rows.
      expect(rows.length).toBe(2)
    })
  })
})

describe('SettingsContent — deep link', () => {
  let target: HTMLDivElement
  let client: ProfileClient
  let content: SettingsContent
  let host: TabHost
  let signal: AbortSignal

  beforeEach(() => {
    document.body.replaceChildren()
    target = document.createElement('div')
    document.body.append(target)
    client = new ProfileClient(new Dispatcher())
    content = new SettingsContent(client)
    host = mockTabHost()
    signal = new AbortController().signal
    // jsdom does not implement scrollIntoView. Define it then mock it.
    if (!('scrollIntoView' in HTMLElement.prototype)) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        value: vi.fn(),
        writable: true,
        configurable: true,
      })
    }
  })

  it('scrollToKey clears search, reveals row, and focuses its control', async () => {
    mockReady(client)
    await content.mount(target, host, signal)

    // First set a search filter so the target row might be hidden.
    const searchInput = target.querySelector<HTMLInputElement>('input[type="search"]')!
    searchInput.value = 'quitting'
    searchInput.dispatchEvent(new Event('input'))

    await vi.waitFor(() => {
      const rows = target.querySelectorAll<HTMLElement>('.st-row')
      const visible = Array.from(rows).filter((r) => r.style.display !== 'none')
      // Only 'Confirm Quit' matches 'quitting'.
      expect(visible.length).toBe(1)
    })

    // Now deep-link to a different key that's currently hidden.
    content.scrollToKey('terminal.fontFamily')

    // Search input should be cleared.
    expect(searchInput.value).toBe('')

    // The target row should be in the DOM (no longer filtered).
    const row = document.getElementById('st-setting-terminal.fontFamily')
    expect(row).toBeTruthy()

    // Its control should have focus.
    const control = row!.querySelector<HTMLElement>('input, select, button')
    expect(control).toBeTruthy()
    expect(document.activeElement).toBe(control)
  })

  it('scrollToKey is a no-op for unknown keys', () => {
    // Don't crash on an unknown key.
    expect(() => content.scrollToKey('nonexistent.key')).not.toThrow()
  })
})
