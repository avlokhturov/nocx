// @vitest-environment jsdom
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
