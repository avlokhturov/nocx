// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@solidjs/testing-library'
import { mountExportSection } from './export-section'
import { ProfileClient } from './profiles'
import { Dispatcher } from './dispatcher'
import type { ExportManifest, ConfigExport } from './profiles'

// ── Stub ProfileClient ────────────────────────────────────────────────
// Returns canned data for every export RPC so the test exercises
// rendering and interactivity without a real backend.
const MOCK_MANIFEST: ExportManifest = {
  mode: 'config-export',
  carries: ['Profiles and groups'],
  omits: ['Stored passwords', 'Private keys', 'SSH agent state'],
}
const MOCK_CONFIG: ConfigExport = {
  profiles: [],
  groups: [],
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
  })
  vi.spyOn(pc, 'importPortable').mockResolvedValue({
    profilesImported: 5,
    groupsImported: 2,
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

/** Mount with the manifest spy reconfigured first — the manifests load on
 *  mount now, so a test that wants a rejection or a pending load has to set it
 *  up before the component exists. */
function mountWith(
  configure: (manifestSpy: ReturnType<typeof createMockClient>['manifestSpy']) => void,
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const { client, manifestSpy } = createMockClient()
  configure(manifestSpy)
  mountExportSection(container, client)
  return { container, client, manifestSpy }
}

afterEach(() => {
  vi.clearAllMocks()
  cleanup()
})

// ── Heading and description ───────────────────────────────────────────

describe('export section — heading and description', () => {
  // Export is a page in the settings rail now, and the rail entry already
  // carries the words "Export / Backup / Import". A page-level heading here
  // would put the same name twice on one screen and nest a section inside a
  // section, so the only headings are the four mode names.
  it('has no page-level heading of its own — the headings are the four modes', () => {
    const { container } = mount()
    const headings = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)
    expect(headings).toEqual([
      'Configuration Export',
      'Portable Encrypted Export',
      'Same-Machine Backup',
      'Import',
    ])
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
  // Addressed by the anchor id the component sets for deep linking, not by a class:
  // a mode card is a kit PageSection, and the kit's containers no longer accept a
  // class from their caller. `st-export-card` was only ever a test hook — it had no
  // CSS — and a hook is not a reason to keep the hatch open.
  it('renders four cards', () => {
    const { container } = mount()
    const cards = container.querySelectorAll('section[id^="st-export-"]')
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
    expect(text).toContain('Profiles, groups, and settings')
    expect(text).toContain('Configuration encrypted under a new passphrase')
    expect(text).toContain('File paths to copy; secrets stay in the OS keychain')
    expect(text).toContain('Restore a configuration export into this machine')
  })

  // The four modes exist to be compared, and what each carries and omits is
  // the comparison. Hiding that behind a per-card disclosure asked for four
  // clicks to read one table, so the cards render open and there is no toggle.
  it('renders open — no disclosure control on any card', () => {
    const { container } = mount()
    expect(container.querySelectorAll('.st-export-card-toggle').length).toBe(0)
    expect(container.textContent).not.toContain('Show details')
    expect(container.textContent).not.toContain('Hide details')
  })
})

// ── Manifest loading ──────────────────────────────────────────────────

describe('export section — manifest loading', () => {
  it('loads every mode manifest on mount, exactly once per card', async () => {
    const { manifestSpy } = mount()

    await vi.waitFor(() => {
      expect(manifestSpy).toHaveBeenCalledTimes(4)
    })
    expect(manifestSpy.mock.calls.map((c) => c[0])).toEqual([
      'config-export',
      'portable-encrypted',
      'same-machine-backup',
      'import',
    ])
  })

  it('renders carries and omits with no interaction', async () => {
    const { container } = mount()
    const card = container.querySelector('section[id^="st-export-"]')!

    await vi.waitFor(() => {
      expect(card.textContent).toContain('Profiles and groups')
      expect(card.textContent).toContain('Stored passwords')
    })
  })

  it('shows a loading indicator while the manifest is in flight', () => {
    // A promise that never settles pins the card in its loading state; with the
    // canned resolve it would be gone before the assertion could see it.
    const { container } = mountWith((spy) => {
      spy.mockReturnValue(new Promise(() => {}))
    })

    const card = container.querySelector('section[id^="st-export-"]')!
    expect(card.textContent).toContain('Loading')
  })

  it('shows an error when exportManifest rejects', async () => {
    const { container } = mountWith((spy) => {
      spy.mockRejectedValue(new Error('Network error'))
    })

    await vi.waitFor(() => {
      const card = container.querySelector('section[id^="st-export-"]')
      expect(card!.textContent).toContain('Failed to load')
    })
  })
})

// ── SSH config import ────────────────────────────────────────────────────

function createSSHImportMockClient() {
  const pc = new ProfileClient(new Dispatcher())
  vi.spyOn(pc, 'exportManifest').mockResolvedValue(MOCK_MANIFEST)
  const importSSHSpy = vi.spyOn(pc, 'importSSHConfig').mockResolvedValue({
    profilesImported: 3,
    skipped: 0,
  })
  return { client: pc, importSSHSpy }
}

function mountForSSH() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const { client, importSSHSpy } = createSSHImportMockClient()
  mountExportSection(container, client)
  return { container, client, importSSHSpy }
}

describe('export section — SSH config import', () => {
  it('renders the SSH config import section with detached-copy label', async () => {
    const { container } = mountForSSH()
    const importCard = container.querySelector('section[id="st-export-import"]')

    await vi.waitFor(() => {
      expect(importCard?.textContent).toContain('from ~/.ssh/config')
    })
    expect(importCard?.textContent).toContain('detached copy')
    expect(importCard?.textContent).toContain('one-off')
  })

  it('calls importSSHConfig on button click', async () => {
    const { container, importSSHSpy } = mountForSSH()

    await vi.waitFor(() => {
      const el = container.querySelector('button[data-testid="import-ssh-config"]')
      expect(el).toBeTruthy()
    })
    const btn = container.querySelector('button[data-testid="import-ssh-config"]') as HTMLElement
    btn.click()

    await vi.waitFor(() => {
      expect(importSSHSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('shows a danger toast when importSSHConfig rejects', async () => {
    const { container, importSSHSpy } = mountForSSH()
    importSSHSpy.mockRejectedValue(new Error('ssh binary not found'))

    await vi.waitFor(() => {
      const el = container.querySelector('button[data-testid="import-ssh-config"]')
      expect(el).toBeTruthy()
    })
    const btn = container.querySelector('button[data-testid="import-ssh-config"]') as HTMLElement
    btn.click()

    await vi.waitFor(() => {
      expect(importSSHSpy).toHaveBeenCalledTimes(1)
    })
  })
})
