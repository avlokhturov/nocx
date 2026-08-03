// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup } from '@solidjs/testing-library'
import { mountExportSection } from './export-section'
import { ProfileClient } from './profiles'
import { Dispatcher } from './dispatcher'
import type { ExportManifest } from './profiles'

// The dialog is a real <dialog> element jsdom cannot open, so the helper is
// mocked (the same pattern as tabs.test.ts). showToast writes into a module
// store with no host in a bare mount, so it is asserted through a spy.
const showToastMock = vi.fn()
const showConfirmMock = vi.fn()
vi.mock('./ui/dialog', () => ({
  showConfirm: (...args: unknown[]) => showConfirmMock(...args) as Promise<boolean>,
}))
vi.mock('./ui/toast', () => ({
  showToast: (...args: unknown[]) => showToastMock(...args) as number,
}))

// ── Stub ProfileClient ────────────────────────────────────────────────
// Returns canned data for every export RPC so the test exercises rendering
// and interactivity without a real backend.
function createMockClient() {
  const pc = new ProfileClient(new Dispatcher())
  const manifestSpy = vi
    .spyOn(pc, 'exportManifest')
    .mockImplementation((mode: string): Promise<ExportManifest> =>
      Promise.resolve({
        mode,
        carries: ['SSH connection profiles', 'Settings and preferences'],
        omits: ['Secret material'],
        notes: ['Encryption: NaCl secretbox'],
      }),
    )
  const portableSpy = vi.spyOn(pc, 'portableEncryptedExport').mockResolvedValue({
    payload: 'dGVzdA==',
    includePrivateContent: false,
  })
  const importPortableSpy = vi.spyOn(pc, 'importPortable').mockResolvedValue({
    profilesImported: 5,
    groupsImported: 2,
  })
  const tabbyPreviewSpy = vi.spyOn(pc, 'tabbyPreview').mockResolvedValue({
    profilesToImport: 2,
    groupsToImport: 1,
    secretsToImport: 0,
    profileEntries: [{ name: 'web', action: 'new' }],
    groupNames: ['Work'],
    secretProvider: 'system',
    planToken: 'tok-1',
  })
  const tabbyExecuteSpy = vi.spyOn(pc, 'tabbyExecute').mockResolvedValue({
    profilesImported: 2,
    groupsImported: 1,
  })
  return {
    client: pc,
    manifestSpy,
    portableSpy,
    importPortableSpy,
    tabbyPreviewSpy,
    tabbyExecuteSpy,
  }
}

// mountExportSection uses Solid's own render, which @solidjs/testing-library's
// cleanup() does not track: an undisposed root stays mounted, keeps its DOM
// attached to document.body, and its effects keep running into the next test.
// The disposer is the only way to tear it down, so every mount hands it over.
const disposers: Array<() => void> = []
function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const spies = createMockClient()
  disposers.push(mountExportSection(container, spies.client))
  return { container, ...spies }
}

function passphraseFields(container: HTMLElement, sectionId: string) {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>(`section#${sectionId} input[type="password"]`),
  )
}

function setPassphrase(container: HTMLElement, value: string, sectionId: string, index = 0) {
  const field = passphraseFields(container, sectionId)[index]
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function setFile(container: HTMLElement, id: string, name: string, content = 'x') {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)
  if (!input) throw new Error(`no file input #${id}`)
  const file = new File([content], name, { type: 'application/octet-stream' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function buttonByText(container: HTMLElement, text: string) {
  const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!btn) throw new Error(`no button "${text}"`)
  return btn
}

beforeEach(() => {
  // downloadBinary reaches URL.createObjectURL, which jsdom does not implement.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:test'),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  cleanup()
})
describe('export section — heading and description', () => {
  // verbs plus the one real third thing — no inventory of file formats.
  it('has no page-level heading of its own — the headings are the two verbs and Tabby', () => {
    const { container } = mount()
    const headings = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)
    expect(headings).toEqual(['Make a backup', 'Restore a backup', 'Import from Tabby'])
  })

  it('renders a description paragraph that names the one file', () => {
    const { container } = mount()
    const desc = container.querySelector('p')
    expect(desc).toBeTruthy()
    expect(desc!.textContent).toContain('backup')
  })
})

// ── Sections ──────────────────────────────────────────────────────────

describe('export section — sections', () => {
  it('renders three sections', () => {
    const { container } = mount()
    const cards = container.querySelectorAll('section[id^="st-export-"]')
    expect(cards.length).toBe(3)
  })

  it('loads exactly the two manifests the sections show, once each', async () => {
    const { manifestSpy } = mount()

    await vi.waitFor(() => {
      expect(manifestSpy).toHaveBeenCalledTimes(2)
    })
    expect(manifestSpy.mock.calls.map((c) => c[0]).sort()).toEqual(['import', 'portable-encrypted'])
  })

  it('renders the manifest carries with no interaction', async () => {
    const { container } = mount()

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Settings and preferences')
      expect(container.textContent).toContain('Secret material')
    })
  })
})

// ── Make a backup ─────────────────────────────────────────────────────

describe('export section — make a backup', () => {
  it('shows the passphrase controls and an enabled button from the start', () => {
    const { container } = mount()
    const btn = buttonByText(container, 'Make backup')
    expect(btn.disabled).toBe(false)
    expect(container.textContent).toContain('Confirm passphrase')
    expect(container.textContent).toContain('Include private content')
  })

  it('refuses an empty passphrase without calling the client', () => {
    const { container, portableSpy } = mount()
    buttonByText(container, 'Make backup').click()
    expect(portableSpy).not.toHaveBeenCalled()
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warning', message: 'Passphrase is required' }),
    )
  })

  it('refuses mismatched passphrases without calling the client', () => {
    const { container, portableSpy } = mount()
    setPassphrase(container, 'one', 'st-export-backup')
    setPassphrase(container, 'two', 'st-export-backup', 1)
    buttonByText(container, 'Make backup').click()
    expect(portableSpy).not.toHaveBeenCalled()
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warning', message: 'Passphrases do not match' }),
    )
  })

  it('calls portableEncryptedExport with the passphrase and default private-content off', async () => {
    const { container, portableSpy } = mount()
    setPassphrase(container, 'correct horse', 'st-export-backup')
    setPassphrase(container, 'correct horse', 'st-export-backup', 1)
    buttonByText(container, 'Make backup').click()

    await vi.waitFor(() => {
      expect(portableSpy).toHaveBeenCalledTimes(1)
    })
    expect(portableSpy).toHaveBeenCalledWith('correct horse', false)
    // The result appears afterwards: a success toast.
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'success',
        message: 'Backup downloaded — keep the passphrase safe',
      }),
    )
  })

  it('passes includePrivateContent when the checkbox is ticked', async () => {
    const { container, portableSpy } = mount()
    setPassphrase(container, 'pw', 'st-export-backup')
    setPassphrase(container, 'pw', 'st-export-backup', 1)
    const include = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).find((c) => c.closest('label')?.textContent?.includes('Include private content'))
    include!.click()
    buttonByText(container, 'Make backup').click()

    await vi.waitFor(() => {
      expect(portableSpy).toHaveBeenCalledWith('pw', true)
    })
  })

  it('the reveal toggle changes the passphrase fields to text — a decision, not a default', () => {
    const { container } = mount()
    expect(passphraseFields(container, 'st-export-backup').length).toBe(2)
    const reveal = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).find((c) => c.closest('label')?.textContent?.includes('Show passphrase'))
    reveal!.click()
    expect(passphraseFields(container, 'st-export-backup').length).toBe(0)
    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>('section#st-export-backup input'),
      ).filter((i) => i.type === 'text').length,
    ).toBeGreaterThanOrEqual(2)
  })
})

// ── Restore a backup ──────────────────────────────────────────────────

describe('export section — restore a backup', () => {
  it('the restore button is disabled until a file and a passphrase are given', () => {
    const { container } = mount()
    expect(buttonByText(container, 'Restore backup').disabled).toBe(true)
    setFile(container, 'restore-backup-file', 'backup.enc')
    expect(buttonByText(container, 'Restore backup').disabled).toBe(true)
    setPassphrase(container, 'pw', 'st-export-restore')
    expect(buttonByText(container, 'Restore backup').disabled).toBe(false)
  })

  it('calls importPortable with the file bytes and the passphrase', async () => {
    const { container, importPortableSpy } = mount()
    setFile(container, 'restore-backup-file', 'backup.enc', 'x')
    setPassphrase(container, 'pw', 'st-export-restore')
    buttonByText(container, 'Restore backup').click()

    await vi.waitFor(() => {
      expect(importPortableSpy).toHaveBeenCalledTimes(1)
    })
    // 'x' base64-encoded is 'eA=='.
    expect(importPortableSpy).toHaveBeenCalledWith('eA==', 'pw')
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'success',
        message: 'Restored 5 profiles, 2 groups',
      }),
    )
  })

  it('a failing restore surfaces a danger toast', async () => {
    const { container, importPortableSpy } = mount()
    importPortableSpy.mockRejectedValue(new Error('wrong passphrase'))
    setFile(container, 'restore-backup-file', 'backup.enc', 'x')
    setPassphrase(container, 'pw', 'st-export-restore')
    buttonByText(container, 'Restore backup').click()

    await vi.waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'danger',
          message: 'Restore failed: Error: wrong passphrase',
        }),
      )
    })
  })
})

// ── Import from Tabby ─────────────────────────────────────────────────

describe('export section — import from Tabby', () => {
  it('previews first: the execute call only happens after confirmation', async () => {
    const { container, tabbyPreviewSpy, tabbyExecuteSpy } = mount()
    showConfirmMock.mockResolvedValue(true)
    setFile(container, 'tabby-config-file', 'config.yml', 'version: 8')
    buttonByText(container, 'Preview import').click()

    await vi.waitFor(() => {
      expect(tabbyPreviewSpy).toHaveBeenCalledTimes(1)
    })
    expect(tabbyPreviewSpy).toHaveBeenCalledWith('version: 8', undefined)
    await vi.waitFor(() => {
      expect(tabbyExecuteSpy).toHaveBeenCalledWith('tok-1')
    })
  })

  it('a cancelled confirmation executes nothing', async () => {
    const { container, tabbyPreviewSpy, tabbyExecuteSpy } = mount()
    showConfirmMock.mockResolvedValue(false)
    setFile(container, 'tabby-config-file', 'config.yml', 'version: 8')
    buttonByText(container, 'Preview import').click()

    await vi.waitFor(() => {
      expect(tabbyPreviewSpy).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(showConfirmMock).toHaveBeenCalled()
    })
    expect(tabbyExecuteSpy).not.toHaveBeenCalled()
  })
})
