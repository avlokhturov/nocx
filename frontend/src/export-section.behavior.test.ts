// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, cleanup } from '@solidjs/testing-library'
import { mountExportSection } from './export-section'
import { ProfileClient } from './profiles'
import { Dispatcher } from './dispatcher'
import type { ExportManifest, ConfigExport } from './profiles'

// ── Stub ProfileClient ────────────────────────────────────────────────
// Returns canned data for every export RPC so the test exercises
// rendering and interactivity without a real backend.
const MOCK_MANIFEST: ExportManifest = {
  mode: 'config-export',
  carries: ['Profiles and groups', 'Credential metadata (not secrets)'],
  omits: ['Stored passwords', 'Private keys', 'SSH agent state'],
}

const MOCK_CONFIG: ConfigExport = {
  profiles: [],
  groups: [],
  credentials: [],
  settings: { theme: 'dark' },
}

/** Return a ProfileClient whose export methods return canned data, plus the
 *  exportManifest spy for call-count and rejection assertions. */
function createMockClient() {
  const pc = new ProfileClient(new Dispatcher())
  const manifestSpy = vi.spyOn(pc, 'exportManifest').mockResolvedValue(MOCK_MANIFEST)
  vi.spyOn(pc, 'configExport').mockResolvedValue(MOCK_CONFIG)
  vi.spyOn(pc, 'portableEncryptedExport').mockResolvedValue({
    payload: 'dGVzdA==',
    includePrivateContent: false,
  })
  vi.spyOn(pc, 'backup').mockResolvedValue({
    mode: 'same-machine-backup',
    configDir: '/home/user/.config/nocx',
    contentDbPath: '/home/user/.local/share/nocx/terminal.db',
    contentDbAbsent: false,
    secretsStatement: 'Secrets are stored in the OS keychain',
    carries: ['Configuration files'],
    omits: ['Secrets'],
  })
  vi.spyOn(pc, 'importConfig').mockResolvedValue({
    profilesImported: 3,
    groupsImported: 1,
    credentialsImported: 2,
  })
  vi.spyOn(pc, 'importPortable').mockResolvedValue({
    profilesImported: 5,
    groupsImported: 2,
    credentialsImported: 3,
  })
  return { client: pc, manifestSpy }
}

// ── Mount/cleanup helpers ─────────────────────────────────────────────

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const { client, manifestSpy } = createMockClient()
  mountExportSection(container, client)
  return { container, client, manifestSpy }
}

afterEach(() => {
  vi.clearAllMocks()
  cleanup()
})

// ── Heading and description ───────────────────────────────────────────

describe('export section — heading and description', () => {
  it('renders a heading with the expected title', () => {
    const { container } = mount()
    const heading = container.querySelector('h2')
    expect(heading).toBeTruthy()
    expect(heading!.textContent).toBe('Export / Backup / Import')
  })

  it('renders a description paragraph', () => {
    const { container } = mount()
    const desc = container.querySelector('p')
    expect(desc).toBeTruthy()
    expect(desc!.textContent).toContain('Each mode')
  })
})

// ── Mode cards ────────────────────────────────────────────────────────

describe('export section — mode cards', () => {
  it('renders four cards', () => {
    const { container } = mount()
    const cards = container.querySelectorAll('.st-export-card')
    expect(cards.length).toBe(4)
  })

  it('renders all four labels', () => {
    const { container } = mount()
    const text = container.textContent
    expect(text).toContain('Configuration Export')
    expect(text).toContain('Portable Encrypted Export')
    expect(text).toContain('Same-Machine Backup')
    expect(text).toContain('Import')
  })

  it('renders all four summaries', () => {
    const { container } = mount()
    const text = container.textContent
    expect(text).toContain('Profiles, groups, credential metadata, and settings')
    expect(text).toContain('Configuration encrypted under a new passphrase')
    expect(text).toContain('File paths to copy; secrets stay in the OS keychain')
    expect(text).toContain('Restore a configuration export into this machine')
  })

  it('each card has a toggle button starting with "Show details"', () => {
    const { container } = mount()
    const toggles = container.querySelectorAll('.st-export-card-toggle')
    expect(toggles.length).toBe(4)
    for (const toggle of toggles) {
      expect(toggle.textContent).toBe('Show details')
    }
  })
})

// ── Expand/collapse ───────────────────────────────────────────────────

describe('export section — expand and collapse', () => {
  it('clicking toggle adds expanded class and changes button text', () => {
    const { container } = mount()
    const card = container.querySelector('.st-export-card')!
    const toggle = card.querySelector('.st-export-card-toggle')!

    expect(card.classList.contains('st-export-card-expanded')).toBe(false)

    fireEvent.click(toggle)
    expect(card.classList.contains('st-export-card-expanded')).toBe(true)
    expect(toggle.textContent).toBe('Hide details')
  })

  it('clicking toggle again collapses and reverts button text', () => {
    const { container } = mount()
    const card = container.querySelector('.st-export-card')!
    const toggle = card.querySelector('.st-export-card-toggle')!

    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(card.classList.contains('st-export-card-expanded')).toBe(false)
    expect(toggle.textContent).toBe('Show details')
  })

  it('shows a loading indicator on first expand', () => {
    const { container } = mount()
    const card = container.querySelector('.st-export-card')!
    const toggle = card.querySelector('.st-export-card-toggle')!

    fireEvent.click(toggle)
    const body = card.querySelector('.st-export-card-body')
    expect(body!.innerHTML).toContain('Loading')
  })

  it('calls exportManifest once on first expand and renders carries/omits', async () => {
    const { container, manifestSpy } = mount()
    const card = container.querySelector('.st-export-card')!
    const toggle = card.querySelector('.st-export-card-toggle')!

    fireEvent.click(toggle)

    await vi.waitFor(() => {
      expect(manifestSpy).toHaveBeenCalledTimes(1)
      const body = card.querySelector('.st-export-card-body')
      expect(body!.textContent).toContain('Profiles and groups')
    })
  })

  it('does not re-fetch manifest on collapse + re-expand', async () => {
    const { container, manifestSpy } = mount()
    const card = container.querySelector('.st-export-card')!
    const toggle = card.querySelector('.st-export-card-toggle')!

    // Expand
    fireEvent.click(toggle)
    await vi.waitFor(() => {
      expect(manifestSpy).toHaveBeenCalledTimes(1)
    })

    // Collapse + re-expand
    fireEvent.click(toggle)
    fireEvent.click(toggle)

    // Should not be called again
    expect(manifestSpy).toHaveBeenCalledTimes(1)
  })

  it('shows an error when exportManifest rejects', async () => {
    const { container, manifestSpy } = mount()
    const card = container.querySelector('.st-export-card')!
    const toggle = card.querySelector('.st-export-card-toggle')!

    manifestSpy.mockRejectedValueOnce(new Error('Network error'))

    fireEvent.click(toggle)
    await vi.waitFor(() => {
      const body = card.querySelector('.st-export-card-body')
      expect(body!.textContent).toContain('Failed to load')
    })
  })
})
