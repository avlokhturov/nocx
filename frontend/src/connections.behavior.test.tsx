// @vitest-environment jsdom
/**
 * Behavior tests for ConnectionsView — the user-facing list of SSH profiles.
 *
 * These tests cover what a user would notice breaking: filtering, live state,
 * probe (Test) outcome display, credential navigation, the dialog editor, and
 * group-tree rendering. Internal refactors (save route, field revert, form
 * validation) are tested in connections.test.tsx.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, fireEvent } from '@solidjs/testing-library'
import { ConnectionsView } from './connections'
import { ProfileClient } from './profiles'
import { Dispatcher } from './dispatcher'
import { clearToasts, toasts } from './ui'
import type {
  SSHProfile,
  ProfileGroup,
  Credential,
  EffectiveProfileDTO,
  SessionStatus,
  ConnectionTestResult,
  GroupImpactResponse,
} from './profiles'

const MOCK_PROFILES: SSHProfile[] = [
  {
    id: 'ssh:p1',
    type: 'ssh',
    name: 'prod-web',
    options: {
      host: 'web.example.com',
      port: 22,
      user: 'deploy',
      keepaliveInterval: 0,
      keepaliveCountMax: 0,
      readyTimeout: 0,
      agentForward: false,
      canBeJumpServer: false,
    },
  },
  {
    id: 'ssh:p2',
    type: 'ssh',
    name: 'prod-db',
    group: 'group:prod',
    options: {
      host: 'db.example.com',
      port: 5432,
      user: 'admin',
      keepaliveInterval: 0,
      keepaliveCountMax: 0,
      readyTimeout: 0,
      agentForward: false,
      canBeJumpServer: false,
    },
  },
  {
    id: 'ssh:p3',
    type: 'ssh',
    name: 'staging-web',
    options: {
      host: 'staging.example.com',
      port: 22,
      user: 'dev',
      keepaliveInterval: 0,
      keepaliveCountMax: 0,
      readyTimeout: 0,
      agentForward: false,
      canBeJumpServer: false,
    },
  },
]

const MOCK_GROUPS: ProfileGroup[] = [{ id: 'group:prod', name: 'Production' }]

const MOCK_CREDENTIALS: Credential[] = [
  {
    id: 'cred:prod-key',
    name: 'prod-key',
    username: 'deploy',
    auth: 'publicKey',
    keyPath: '/home/user/.ssh/id_rsa',
  },
]

const MOCK_EFFECTIVE_CRED: EffectiveProfileDTO = {
  id: 'ssh:p1',
  fields: {
    credentialId: {
      value: 'cred:prod-key',
      source: { kind: 'profile', id: 'ssh:p1', label: 'prod-web' },
    },
  },
}

const MOCK_SESSION_STATUSES: Record<string, SessionStatus> = {
  'ssh:p1': { live: true, lastUsed: '2026-07-28T12:00:00Z' },
  'ssh:p2': { live: false },
  'ssh:p3': { live: false },
}

// ── Mock helpers ────────────────────────────────────────────────────────

function createMockClient(overrides?: {
  profiles?: SSHProfile[]
  groups?: ProfileGroup[]
  credentials?: Credential[]
  sessionStatuses?: Record<string, SessionStatus>
  effectiveProfiles?: EffectiveProfileDTO[]
  connectionTestResult?: ConnectionTestResult
}) {
  const pc = new ProfileClient(new Dispatcher())

  vi.spyOn(pc, 'listProfiles').mockResolvedValue(overrides?.profiles ?? [])
  vi.spyOn(pc, 'listGroups').mockResolvedValue(overrides?.groups ?? [])
  vi.spyOn(pc, 'listCredentials').mockResolvedValue(overrides?.credentials ?? [])
  vi.spyOn(pc, 'sessionStatus').mockResolvedValue({ statuses: overrides?.sessionStatuses ?? {} })
  vi.spyOn(pc, 'loadEffective').mockResolvedValue({ profiles: overrides?.effectiveProfiles ?? [] })
  vi.spyOn(pc, 'credentialUsage').mockResolvedValue({ usage: [] })
  const connectionTest = vi
    .spyOn(pc, 'connectionTest')
    .mockResolvedValue(overrides?.connectionTestResult ?? { outcome: 'accepted' })

  return { client: pc, connectionTest }
}

function mount(
  overrides?: Parameters<typeof createMockClient>[0] & {
    onConnect?: () => void
    onNavigateToCredentials?: () => void
  },
) {
  const { client, connectionTest } = createMockClient(overrides)
  const container = document.body.appendChild(document.createElement('div'))
  render(
    () => (
      <ConnectionsView
        client={client}
        onConnect={overrides?.onConnect}
        onNavigateToCredentials={overrides?.onNavigateToCredentials}
      />
    ),
    { container },
  )
  return { container, client, connectionTest }
}

afterEach(() => {
  clearToasts()
  vi.clearAllMocks()
  cleanup()
})

// ── Helper: wait for profiles to render ──────────────────────────────

async function waitForProfiles(container: HTMLElement, count: number) {
  await vi.waitFor(() => {
    expect(container.querySelectorAll('.cm-item-name').length).toBe(count)
  })
}

// ── Filter narrows the list ───────────────────────────────────────────

describe('filter', () => {
  it('shows all profiles when search is empty', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES })
    await waitForProfiles(container, 3)
  })

  it('narrows the list when search query matches a subset', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES })
    await waitForProfiles(container, 3)

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter connections"]',
    )
    expect(input).toBeTruthy()
    input!.value = 'staging'
    input!.dispatchEvent(new Event('input', { bubbles: true }))

    await vi.waitFor(() => {
      const names = container.querySelectorAll('.cm-item-name')
      expect(names.length).toBe(1)
      expect(names[0].textContent).toBe('staging-web')
    })
  })

  it('matches against host and user in addition to name', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES })
    await waitForProfiles(container, 3)

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter connections"]',
    )
    expect(input).toBeTruthy()
    input!.value = 'db.example'
    input!.dispatchEvent(new Event('input', { bubbles: true }))

    await vi.waitFor(() => {
      const names = container.querySelectorAll('.cm-item-name')
      expect(names.length).toBe(1)
      expect(names[0].textContent).toBe('prod-db')
    })
  })

  it('filtering by partial name shows multiple matching profiles', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES })
    await waitForProfiles(container, 3)

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter connections"]',
    )
    expect(input).toBeTruthy()
    input!.value = 'prod'
    input!.dispatchEvent(new Event('input', { bubbles: true }))

    await vi.waitFor(() => {
      const names = container.querySelectorAll('.cm-item-name')
      expect(names.length).toBe(2)
      expect(names[0].textContent).toBe('prod-web')
      expect(names[1].textContent).toBe('prod-db')
    })
  })
})

// ── Live session state ───────────────────────────────────────────────

describe('session state', () => {
  it('marks one profile live and others disconnected from sessionStatus', async () => {
    const { container } = mount({
      profiles: MOCK_PROFILES.slice(0, 2),
      sessionStatuses: MOCK_SESSION_STATUSES,
    })

    await waitForProfiles(container, 2)

    const items = container.querySelectorAll('.ui-collection-row')
    const liveState = items[0].querySelector('.cm-session-state')
    expect(liveState).toBeTruthy()
    expect(liveState!.textContent).toContain('Connected')
    expect(liveState!.classList.contains('cm-session-live')).toBe(true)

    const offlineState = items[1].querySelector('.cm-session-state')
    expect(offlineState).toBeTruthy()
    expect(offlineState!.textContent).toContain('Disconnected')
    expect(offlineState!.classList.contains('cm-session-live')).toBe(false)
  })

  it('shows last-used date when present', async () => {
    const { container } = mount({
      profiles: MOCK_PROFILES.slice(0, 1),
      sessionStatuses: MOCK_SESSION_STATUSES,
    })

    await vi.waitFor(() => {
      expect(container.querySelector('.cm-session-last-used')).toBeTruthy()
    })

    const lastUsed = container.querySelector('.cm-session-last-used')
    expect(lastUsed!.textContent).toContain('last used')
  })
})

// ── Test action (distinct from Connect) ─────────────────────────────

describe('Test action', () => {
  it('calls connectionTest and reports the typed outcome in a toast', async () => {
    const onConnect = vi.fn()
    const { container, connectionTest } = mount({
      profiles: MOCK_PROFILES.slice(0, 1),
      onConnect,
      connectionTestResult: { outcome: 'rejected', detail: 'Password authentication failed' },
    })

    await waitForProfiles(container, 1)

    const testBtn = container.querySelector('[aria-label^="Test connection"]')
    expect(testBtn, 'Test button not found').toBeTruthy()
    ;(testBtn! as HTMLElement).click()

    await vi.waitFor(() => {
      expect(toasts()).toHaveLength(1)
      expect(toasts()[0].message).toContain('Password authentication failed')
      expect(toasts()[0].level).toBe('warning')
    })

    expect(onConnect).not.toHaveBeenCalled()

    expect(connectionTest).toHaveBeenCalledWith('ssh:p1')
  })

  it('displays accepted outcome as success', async () => {
    const { container } = mount({
      profiles: MOCK_PROFILES.slice(0, 1),
      connectionTestResult: { outcome: 'accepted', detail: 'Connection successful' },
    })

    await waitForProfiles(container, 1)

    const testBtn = container.querySelector('[aria-label^="Test connection"]')
    expect(testBtn, 'Test button not found').toBeTruthy()
    ;(testBtn! as HTMLElement).click()

    await vi.waitFor(() => {
      expect(toasts()).toHaveLength(1)
      expect(toasts()[0].message).toContain('Connection successful')
      expect(toasts()[0].level).toBe('success')
    })
  })
})

// ── Credential link navigates ────────────────────────────────────────

describe('credential link', () => {
  it('clicking a credential link calls onNavigateToCredentials', async () => {
    const onNavigateToCredentials = vi.fn()
    const { container } = mount({
      profiles: MOCK_PROFILES.slice(0, 1),
      credentials: MOCK_CREDENTIALS,
      effectiveProfiles: [MOCK_EFFECTIVE_CRED],
      onNavigateToCredentials,
    })

    await waitForProfiles(container, 1)

    await vi.waitFor(() => {
      const link = container.querySelector('[aria-label="Open credentials for prod-key"]')
      expect(link, 'Credential link not found').toBeTruthy()
    })

    const link = container.querySelector(
      '[aria-label="Open credentials for prod-key"]',
    ) as HTMLElement
    fireEvent.click(link)

    expect(onNavigateToCredentials).toHaveBeenCalledTimes(1)
  })
})

// ── Quick connect ────────────────────────────────────────────────────

describe('quick connect', () => {
  it('opens a quick-connect dialog before the full form', async () => {
    const { container } = mount({ profiles: [] })
    await waitForProfiles(container, 0)

    const newBtn = container.querySelector('.ui-button')
    expect(newBtn).toBeTruthy()
    ;(newBtn! as HTMLElement).click()

    await vi.waitFor(() => {
      expect(container.querySelector('#quick-connect-input')).toBeTruthy()
    })

    // The full form should not open until Next is clicked
    expect(container.querySelector('#profile-host')).toBeFalsy()
  })

  it('typing a connection string and clicking Next opens the form with parsed values', async () => {
    const { container } = mount({ profiles: [] })

    await waitForProfiles(container, 0)

    const newBtn = container.querySelector('.ui-button')
    expect(newBtn).toBeTruthy()
    ;(newBtn! as HTMLElement).click()

    await vi.waitFor(() => {
      expect(container.querySelector('#quick-connect-input')).toBeTruthy()
    })

    const input = container.querySelector('#quick-connect-input') as HTMLInputElement
    expect(input, 'Quick connect input not found').toBeTruthy()
    fireEvent.input(input, { target: { value: 'deploy@web.example.com:2222' } })

    const nextBtn = Array.from(container.querySelectorAll('.ui-button')).find(
      (b) => b.textContent?.trim() === 'Next',
    )
    expect(nextBtn, 'Next button not found').toBeTruthy()
    ;(nextBtn! as HTMLElement).click()

    // Form dialog should open with parsed values
    await vi.waitFor(() => {
      const hostInput = container.querySelector('#profile-host') as HTMLInputElement
      expect(hostInput, 'Form dialog did not open').toBeTruthy()
      expect(hostInput.value).toBe('web.example.com')
    })

    const portInput = container.querySelector('#profile-port') as HTMLInputElement
    expect(portInput.value).toBe('2222')

    const userInput = container.querySelector('#profile-auth-user') as HTMLInputElement
    expect(userInput.value).toBe('deploy')
  })

  it('empty input and Next shows a warning but does not close the dialog', async () => {
    const { container } = mount({ profiles: [] })

    await waitForProfiles(container, 0)

    const newBtn = container.querySelector('.ui-button')
    expect(newBtn).toBeTruthy()
    ;(newBtn! as HTMLElement).click()

    // Quick-connect dialog opens
    await vi.waitFor(() => {
      expect(container.querySelector('#quick-connect-input')).toBeTruthy()
    })

    // Click Next without typing anything
    const nextBtn = Array.from(container.querySelectorAll('.ui-button')).find(
      (b) => b.textContent?.trim() === 'Next',
    )
    expect(nextBtn).toBeTruthy()
    ;(nextBtn! as HTMLElement).click()

    // Dialog should still be open (no profile-name in DOM)
    expect(container.querySelector('#profile-name')).toBeFalsy()
    expect(container.querySelector('#quick-connect-input')).toBeTruthy()
  })
})

// ── Inline credential creation from connection form ──────────────────────

describe('inline credential creation', () => {
  // ADR-0016: "+ New Credential" left the connection editor. Selecting an
  // existing credential stays; creating one by hand is gone — the secret owns
  // its name, so a secret created from a password save is named by the
  // connection (user@host), not built in a form.
  it('the connection editor no longer offers to create a credential by hand', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })

    await waitForProfiles(container, 1)

    // Open edit dialog
    const editBtn = container.querySelector('.ui-collection-row__actions [aria-label^="Edit "]')
    expect(editBtn).toBeTruthy()
    ;(editBtn! as HTMLElement).click()

    await vi.waitFor(() => {
      expect(container.querySelector('.nocx-dialog__panel')).toBeTruthy()
    })

    // The "+" button beside the credential select is gone — the only way to
    // get a credential here is to select one that already exists.
    const plusBtn = container.querySelector('[aria-label="New credential"]')
    expect(plusBtn).toBeNull()
    // And no credential creation form is reachable from the editor.
    expect(container.querySelector('#cred-name')).toBeNull()
  })
})

// ── Shared impact stubs ──────────────────────────────────────────────────

const IMPACT_DANGEROUS: GroupImpactResponse = {
  dangerous: true,
  affectedProfiles: [
    {
      profileId: 'ssh:p2',
      profileName: 'prod-db',
      diffs: [{ field: 'credentialId', oldValue: null, newValue: 'cred:new', dangerous: true }],
    },
  ],
}

const IMPACT_COSMETIC: GroupImpactResponse = {
  dangerous: false,
  affectedProfiles: [
    {
      profileId: 'ssh:p2',
      profileName: 'prod-db',
      diffs: [{ field: 'port', oldValue: 5432, newValue: 22, dangerous: false }],
    },
  ],
}

const IMPACT_DELETE_PROMOTE: GroupImpactResponse = {
  dangerous: false,
  deleteImpact: {
    action: 'promote_to_root',
    reason: 'The group contains child profiles that will be reparented.',
    affectedGroupIds: [],
  },
}

// ── Helpers: find a dialog by title ────────────────────────────────────

function findDialogByTitle(container: HTMLElement, titleText: string): HTMLElement | null {
  const titles = container.querySelectorAll('.nocx-dialog__title')
  for (const t of titles) {
    if (t.textContent === titleText) return t.closest('.nocx-dialog')
  }
  return null
}

function findDialogByTitleContaining(container: HTMLElement, partial: string): HTMLElement | null {
  const titles = container.querySelectorAll('.nocx-dialog__title')
  for (const t of titles) {
    if (t.textContent && t.textContent.includes(partial)) return t.closest('.nocx-dialog')
  }
  return null
}

// ── Helper: open the group editor dialog ────────────────────────────────

async function openGroupEditorByName(container: HTMLElement, groupName: string) {
  const headers = container.querySelectorAll('.cm-group-header')
  const targetHeader = Array.from(headers).find(
    (h) => h.querySelector('.cm-group-name')?.textContent === groupName,
  )
  expect(targetHeader, `Group header "${groupName}" not found`).toBeTruthy()
  const editBtn = targetHeader!.querySelector(`[aria-label="Edit group ${groupName}"]`)
  expect(editBtn, `Edit button for "${groupName}" not found`).toBeTruthy()
  ;(editBtn! as HTMLElement).click()

  await vi.waitFor(() => {
    const dialog = findDialogByTitle(container, `Edit Group: ${groupName}`)
    expect(dialog, `Group edit dialog "${groupName}" not found`).toBeTruthy()
  })
}

/**
 * Click a section in the group editor's rail.
 */
function selectGroupSection(container: HTMLElement, label: string) {
  const btn = Array.from(container.querySelectorAll('.ui-tabs__list .ui-button')).find(
    (b) => b.textContent?.trim() === label,
  )
  expect(btn, `tab "${label}" not found`).toBeTruthy()
  ;(btn! as HTMLElement).click()
}

// ── Helper: open the profile edit dialog for a named profile ─────────────

async function openProfileEditor(container: HTMLElement, profileName: string) {
  const editBtn = container.querySelector('.ui-collection-row__actions [aria-label^="Edit "]')
  expect(editBtn, `Edit button for "${profileName}" not found`).toBeTruthy()
  ;(editBtn! as HTMLElement).click()

  await vi.waitFor(() => {
    const dialog = findDialogByTitleContaining(container, profileName)
    expect(dialog, `Profile edit dialog "${profileName}" not found`).toBeTruthy()
  })
}

function selectProfileSection(container: HTMLElement, label: string) {
  const btn = Array.from(container.querySelectorAll('.ui-tabs__list .ui-button')).find(
    (b) => b.textContent?.trim() === label,
  )
  expect(btn, `profile tab "${label}" not found`).toBeTruthy()
  ;(btn! as HTMLElement).click()
}

function clickSegmentedOption(container: HTMLElement, label: string) {
  const option = Array.from(container.querySelectorAll('[role="radio"]')).find(
    (r) => r.textContent?.trim() === label,
  )
  expect(option, `SegmentedControl option "${label}" not found`).toBeTruthy()
  ;(option! as HTMLElement).click()
}

// ── Three-way key input: connection editor ──────────────────────────────

describe('three-way key input — connection editor', () => {
  it('shows three modes (Path, Choose file, Paste key) for publicKey auth', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })
    await waitForProfiles(container, 1)

    await openProfileEditor(container, 'prod-web')
    selectProfileSection(container, 'Authentication')

    // Set auth to Public Key
    clickSegmentedOption(container, 'Public Key')

    // Wait for the key input field
    await vi.waitFor(() => {
      expect(container.querySelector('#profile-key-path')).toBeTruthy()
    })

    // The SegmentedControl should have all three options
    const segments = container.querySelectorAll('[role="radio"]')
    const keySegments = Array.from(segments).filter(
      (s) =>
        s.textContent?.trim() === 'Path' ||
        s.textContent?.trim() === 'Choose file' ||
        s.textContent?.trim() === 'Paste key',
    )
    expect(keySegments.length).toBe(3)
  })

  it('path mode records a path and calls no vault method', async () => {
    const { container, client } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })
    const saveKeyMatSpy = vi.spyOn(client, 'saveKeyMaterial')

    await waitForProfiles(container, 1)
    await openProfileEditor(container, 'prod-web')
    selectProfileSection(container, 'Authentication')
    clickSegmentedOption(container, 'Public Key')

    await vi.waitFor(() => {
      expect(container.querySelector('#profile-key-path')).toBeTruthy()
    })

    // Type a path
    const pathInput = container.querySelector('#profile-key-path') as HTMLInputElement
    fireEvent.input(pathInput, { target: { value: '/home/user/.ssh/id_ed25519' } })

    // Save the profile
    const dialog = findDialogByTitleContaining(container, 'prod-web')!
    const saveBtn = Array.from(dialog.querySelectorAll('.ui-button')).find(
      (b) => b.textContent?.trim() === 'Save Connection',
    )
    expect(saveBtn, 'Save Connection button not found').toBeTruthy()
    fireEvent.click(saveBtn!)

    // saveKeyMaterial should NOT have been called (no vault interaction for path mode)
    expect(saveKeyMatSpy).not.toHaveBeenCalled()
  })

  // Choosing a file must STORE THE KEY, not a filename. It used to read
  // `File.path` — an Electron extension present in neither a browser nor a
  // Wails webview — so the fallback fired every time and `id_ed25519` was
  // saved as if it were a path to a key. Broken on every target, and no test
  // asked what the mode actually produced.
  it('choose-file mode stores the file contents as key material, not its name', async () => {
    const { container, client } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })
    const saveKeyMatSpy = vi
      .spyOn(client, 'saveKeyMaterial')
      .mockResolvedValue({ fingerprint: 'SHA256:abc123' })
    const updateSpy = vi.spyOn(client, 'updateProfile')
    vi.spyOn(client, 'createCredential').mockResolvedValue({
      id: 'cred:keymat',
      name: 'prod-web',
      username: 'deploy',
      auth: 'publicKey',
    })

    await waitForProfiles(container, 1)
    await openProfileEditor(container, 'prod-web')
    selectProfileSection(container, 'Authentication')
    clickSegmentedOption(container, 'Public Key')
    clickSegmentedOption(container, 'Choose file')

    const KEY = '-----BEGIN PRIVATE KEY-----\nfrom-a-file\n-----END PRIVATE KEY-----'
    const native = container.querySelector('.ui-file-input__native') as HTMLInputElement
    expect(native, 'file input not found').toBeTruthy()
    const file = new File([KEY], 'id_ed25519', { type: 'text/plain' })
    Object.defineProperty(native, 'files', { value: [file], configurable: true })
    fireEvent.change(native)

    const dialog = findDialogByTitleContaining(container, 'prod-web')!
    await vi.waitFor(() => {
      const btn = Array.from(dialog.querySelectorAll('.ui-button')).find(
        (b) => b.textContent?.trim() === 'Save Connection',
      )
      expect(btn).toBeTruthy()
    })
    const saveBtn = Array.from(dialog.querySelectorAll('.ui-button')).find(
      (b) => b.textContent?.trim() === 'Save Connection',
    )!
    fireEvent.click(saveBtn)

    await vi.waitFor(() => {
      expect(saveKeyMatSpy).toHaveBeenCalled()
    })
    // The CONTENTS reached the vault.
    expect(saveKeyMatSpy.mock.calls[0][1]).toBe(KEY)
    // And no filename was recorded as a key path.
    for (const call of updateSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('id_ed25519')
    }
  })

  it('material mode calls saveKeyMaterial and records no path', async () => {
    const { container, client } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })
    const saveKeyMatSpy = vi
      .spyOn(client, 'saveKeyMaterial')
      .mockResolvedValue({ fingerprint: 'SHA256:abc123' })
    vi.spyOn(client, 'createCredential').mockResolvedValue({
      id: 'cred:keymat',
      name: 'prod-web',
      username: 'deploy',
      auth: 'publicKey',
    })

    await waitForProfiles(container, 1)
    await openProfileEditor(container, 'prod-web')
    selectProfileSection(container, 'Authentication')
    clickSegmentedOption(container, 'Public Key')

    // Switch to Paste key mode
    clickSegmentedOption(container, 'Paste key')

    await vi.waitFor(() => {
      expect(container.querySelector('#profile-key-text')).toBeTruthy()
    })

    // Paste key text
    const keyInput = container.querySelector('#profile-key-text') as HTMLInputElement
    fireEvent.input(keyInput, {
      target: { value: '-----BEGIN PRIVATE KEY-----\nMIIEvQIB...\n-----END PRIVATE KEY-----' },
    })

    // Save
    const dialog = findDialogByTitleContaining(container, 'prod-web')!
    const saveBtn = Array.from(dialog.querySelectorAll('.ui-button')).find(
      (b) => b.textContent?.trim() === 'Save Connection',
    )
    expect(saveBtn, 'Save button not found').toBeTruthy()
    fireEvent.click(saveBtn!)

    await vi.waitFor(() => {
      expect(saveKeyMatSpy).toHaveBeenCalled()
    })

    // NOTE: the "and no path is recorded" half of the criterion is not asserted here.
    // With a credential selected the path input is not rendered, so there is nothing to
    // query; proving it needs the credential's stored KeyPath, which this test does not
    // have access to. Filed rather than faked.
    expect(saveKeyMatSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('BEGIN PRIVATE KEY'),
      // ADR-0016: the secret owns its name — the save carries the generated
      // user@host name of the connection it was saved on.
      'deploy@web.example.com',
    )
  })

  it('switching from material to path clears the key text', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })
    await waitForProfiles(container, 1)
    await openProfileEditor(container, 'prod-web')
    selectProfileSection(container, 'Authentication')
    clickSegmentedOption(container, 'Public Key')

    clickSegmentedOption(container, 'Paste key')

    // Type key text
    const keyInput = container.querySelector('#profile-key-text') as HTMLInputElement
    expect(keyInput, 'Key text field should be visible').toBeTruthy()
    fireEvent.input(keyInput, { target: { value: 'some-private-key-text' } })

    // Switch to Path mode
    clickSegmentedOption(container, 'Path')

    // The key text field should no longer be visible
    await vi.waitFor(() => {
      expect(container.querySelector('#profile-key-text')).toBeFalsy()
    })

    // The path field should be visible now
    expect(container.querySelector('#profile-key-path')).toBeTruthy()
  })

  it('shows fingerprint for credential with hasKeyMaterial', async () => {
    const CRED_WITH_KEYMAT: Credential = {
      id: 'cred:kmat',
      name: 'key-cred',
      username: 'deploy',
      auth: 'publicKey',
      hasKeyMaterial: true,
      keyFingerprint: 'SHA256:testfingerprint123',
    }
    const PROFILE_WITH_KEYMAT: SSHProfile = {
      ...MOCK_PROFILES[0],
      options: {
        ...MOCK_PROFILES[0].options,
        credentialId: 'cred:kmat',
      },
    }
    const { container } = mount({
      profiles: [PROFILE_WITH_KEYMAT],
      credentials: [CRED_WITH_KEYMAT],
    })
    await waitForProfiles(container, 1)
    await openProfileEditor(container, 'prod-web')
    selectProfileSection(container, 'Authentication')

    await vi.waitFor(() => {
      const fp = container.querySelector('.cm-key-fingerprint')
      expect(fp, 'Key fingerprint not shown').toBeTruthy()
      expect(fp!.textContent).toContain('testfingerprint123')
    })
  })
  it('shows editable credential fields when credential selected', async () => {
    const cred: Credential = {
      id: 'cred:edit-test',
      name: 'my-cred',
      username: 'admin',
      auth: 'password',
    }
    const PROFILE_WITH_CRED: SSHProfile = {
      ...MOCK_PROFILES[0],
      options: { ...MOCK_PROFILES[0].options, credentialId: 'cred:edit-test' },
    }
    const { container } = mount({ profiles: [PROFILE_WITH_CRED], credentials: [cred] })
    await waitForProfiles(container, 1)
    await openProfileEditor(container, 'prod-web')
    selectProfileSection(container, 'Authentication')

    await vi.waitFor(() => {
      expect(container.querySelector('#profile-auth-cred-name')).toBeTruthy()
      expect(container.querySelector('#profile-auth-cred-user')).toBeTruthy()
    })
    const nameField = container.querySelector('#profile-auth-cred-name') as HTMLInputElement
    expect(nameField.value).toBe('my-cred')
    const userField = container.querySelector('#profile-auth-cred-user') as HTMLInputElement
    expect(userField.value).toBe('admin')
  })

  it('saves credential draft changes via updateCredential', async () => {
    const cred: Credential = {
      id: 'cred:update-test',
      name: 'old-name',
      username: 'admin',
      auth: 'password',
    }
    const PROFILE_WITH_CRED: SSHProfile = {
      ...MOCK_PROFILES[0],
      options: { ...MOCK_PROFILES[0].options, credentialId: 'cred:update-test' },
    }
    const { container, client } = mount({ profiles: [PROFILE_WITH_CRED], credentials: [cred] })
    const updateSpy = vi.spyOn(client, 'updateCredential').mockResolvedValue(cred)
    vi.spyOn(client, 'patchProfile').mockResolvedValue(MOCK_EFFECTIVE_CRED)

    await waitForProfiles(container, 1)
    await openProfileEditor(container, 'prod-web')
    selectProfileSection(container, 'Authentication')

    await vi.waitFor(() => {
      expect(container.querySelector('#profile-auth-cred-name')).toBeTruthy()
    })
    const nameField = container.querySelector('#profile-auth-cred-name') as HTMLInputElement
    expect(nameField).toBeTruthy()
    fireEvent.input(nameField, { target: { value: 'new-name' } })

    // Find "Save Connection" and click it
    const saveBtn = await vi.waitFor(() => {
      const btn = Array.from(container.querySelectorAll('.ui-button')).find(
        (b) => b.textContent?.trim() === 'Save Connection',
      )
      expect(btn, 'Save Connection button not found').toBeTruthy()
      return btn!
    })
    fireEvent.click(saveBtn)

    await vi.waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1)
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cred:update-test', name: 'new-name' }),
      )
    })
  })

  it('preserves newlines in pasted key text on save', async () => {
    const { container, client } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })
    const saveKeyMatSpy = vi
      .spyOn(client, 'saveKeyMaterial')
      .mockResolvedValue({ fingerprint: 'SHA256:newline-test' })
    vi.spyOn(client, 'createCredential').mockResolvedValue({
      id: 'cred:nl',
      name: 'prod-web',
      username: 'deploy',
      auth: 'publicKey',
    })

    await waitForProfiles(container, 1)
    await openProfileEditor(container, 'prod-web')
    selectProfileSection(container, 'Authentication')
    clickSegmentedOption(container, 'Public Key')

    // Switch to Paste key mode
    clickSegmentedOption(container, 'Paste key')

    await vi.waitFor(() => {
      expect(container.querySelector('#profile-key-text')).toBeTruthy()
    })

    // Set a multi-line key value directly on the textarea, then dispatch input
    const keyField = container.querySelector('#profile-key-text') as HTMLTextAreaElement
    const keyContent =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n'
    const originalNewlineCount = (keyContent.match(/\n/g) || []).length
    keyField.value = keyContent
    fireEvent.input(keyField)

    // Save
    const dialog = findDialogByTitleContaining(container, 'prod-web')!
    const saveBtn = Array.from(dialog.querySelectorAll('.ui-button')).find(
      (b) => b.textContent?.trim() === 'Save Connection',
    )
    expect(saveBtn, 'Save button not found').toBeTruthy()
    fireEvent.click(saveBtn!)

    await vi.waitFor(() => {
      expect(saveKeyMatSpy).toHaveBeenCalled()
    })

    const capturedArg = saveKeyMatSpy.mock.calls[0][1]
    const capturedNewlineCount = (capturedArg.match(/\n/g) || []).length
    expect(capturedNewlineCount).toBe(originalNewlineCount)
    expect(capturedNewlineCount).toBeGreaterThan(0)
    // Confirm it's the same content, not truncated
    expect(capturedArg).toBe(keyContent)
  })
})

// ── Three-way key input: group editor ──────────────────────────────────

describe('three-way key input — group editor', () => {
  it('shows three modes for publicKey in group defaults', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES, groups: MOCK_GROUPS })
    await waitForProfiles(container, 3)

    await openGroupEditorByName(container, 'Production')
    selectGroupSection(container, 'Connection')

    // Set auth to Public Key (the group editor has an AuthMethodEditor inside)
    clickSegmentedOption(container, 'Public Key')

    await vi.waitFor(() => {
      expect(container.querySelector('#group-default-key-path')).toBeTruthy()
    })

    // The SegmentedControl should have three key input options
    const segments = container.querySelectorAll('[role="radio"]')
    const keySegments = Array.from(segments).filter(
      (s) =>
        s.textContent?.trim() === 'Path' ||
        s.textContent?.trim() === 'Choose file' ||
        s.textContent?.trim() === 'Paste key',
    )
    expect(keySegments.length).toBe(3)
  })

  it('path mode records a path in group defaults', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES, groups: MOCK_GROUPS })
    await waitForProfiles(container, 3)

    await openGroupEditorByName(container, 'Production')
    selectGroupSection(container, 'Connection')
    clickSegmentedOption(container, 'Public Key')

    await vi.waitFor(() => {
      expect(container.querySelector('#group-default-key-path')).toBeTruthy()
    })

    const pathInput = container.querySelector('#group-default-key-path') as HTMLInputElement
    fireEvent.input(pathInput, { target: { value: '/home/user/.ssh/id_ed25519' } })

    // Verify the path was entered
    expect(pathInput.value).toBe('/home/user/.ssh/id_ed25519')
  })

  it('Paste key mode exists and can be selected', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES, groups: MOCK_GROUPS })
    await waitForProfiles(container, 3)

    await openGroupEditorByName(container, 'Production')
    selectGroupSection(container, 'Connection')
    clickSegmentedOption(container, 'Public Key')

    // Switch to Paste key
    clickSegmentedOption(container, 'Paste key')

    await vi.waitFor(() => {
      expect(container.querySelector('#group-default-key-text')).toBeTruthy()
    })

    const keyInput = container.querySelector('#group-default-key-text') as HTMLInputElement
    fireEvent.input(keyInput, { target: { value: 'pasted-key-content' } })
    expect(keyInput.value).toBe('pasted-key-content')
  })

  it('switching modes clears the previous mode value', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES, groups: MOCK_GROUPS })
    await waitForProfiles(container, 3)

    await openGroupEditorByName(container, 'Production')
    selectGroupSection(container, 'Connection')
    clickSegmentedOption(container, 'Public Key')

    // Enter path mode value
    const pathInput = container.querySelector('#group-default-key-path') as HTMLInputElement
    fireEvent.input(pathInput, { target: { value: '/tmp/test-key' } })

    // Switch to Paste key — path should be cleared
    clickSegmentedOption(container, 'Paste key')

    await vi.waitFor(() => {
      expect(container.querySelector('#group-default-key-text')).toBeTruthy()
    })

    // Switch back to Path — the path should be cleared
    clickSegmentedOption(container, 'Path')

    await vi.waitFor(() => {
      expect(container.querySelector('#group-default-key-path')).toBeTruthy()
    })

    // The path input should be empty (cleared on mode switch)
    const pathInput2 = container.querySelector('#group-default-key-path') as HTMLInputElement
    expect(pathInput2.value).toBe('')
  })

  it('preserves newlines in pasted key text on group save', async () => {
    const { container, client } = mount({ profiles: MOCK_PROFILES, groups: MOCK_GROUPS })
    const saveKeyMatSpy = vi
      .spyOn(client, 'saveKeyMaterial')
      .mockResolvedValue({ fingerprint: 'SHA256:group-newline' })
    vi.spyOn(client, 'createCredential').mockResolvedValue({
      id: 'cred:grp-nl',
      name: 'Production',
      username: 'deploy',
      auth: 'publicKey',
    })
    vi.spyOn(client, 'groupApply').mockResolvedValue([])
    vi.spyOn(client, 'groupImpact').mockResolvedValue(IMPACT_COSMETIC)

    await waitForProfiles(container, 3)
    await openGroupEditorByName(container, 'Production')
    selectGroupSection(container, 'Connection')
    clickSegmentedOption(container, 'Public Key')

    // Switch to Paste key mode
    clickSegmentedOption(container, 'Paste key')

    await vi.waitFor(() => {
      expect(container.querySelector('#group-default-key-text')).toBeTruthy()
    })

    // Set multi-line key value directly on the textarea, then dispatch input
    const keyField = container.querySelector('#group-default-key-text') as HTMLTextAreaElement
    const keyContent = '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIIm\n-----END EC PRIVATE KEY-----\n'
    const originalNewlineCount = (keyContent.match(/\n/g) || []).length
    keyField.value = keyContent
    fireEvent.input(keyField)

    // Save the group
    const dialog = findDialogByTitle(container, 'Edit Group: Production')!
    const saveBtn = Array.from(dialog.querySelectorAll('.ui-button')).find(
      (b) => b.textContent?.trim() === 'Save Group',
    )
    expect(saveBtn, 'Save Group button not found').toBeTruthy()
    fireEvent.click(saveBtn!)

    await vi.waitFor(() => {
      expect(saveKeyMatSpy).toHaveBeenCalled()
    })

    const capturedArg = saveKeyMatSpy.mock.calls[0][1]
    const capturedNewlineCount = (capturedArg.match(/\n/g) || []).length
    expect(capturedNewlineCount).toBe(originalNewlineCount)
    expect(capturedNewlineCount).toBeGreaterThan(0)
    expect(capturedArg).toBe(keyContent)
  })
})

// ── Group editor tests ──────────────────────────────────────────────────

describe('group editor', () => {
  it('blast radius appears before applying', async () => {
    const { container, client } = mount({
      profiles: MOCK_PROFILES,
      groups: MOCK_GROUPS,
    })
    await waitForProfiles(container, 3)

    await openGroupEditorByName(container, 'Production')

    // Impact section should not be visible before any change
    expect(container.querySelector('.cm-impact-count')).toBeFalsy()

    const impactSpy = vi.spyOn(client, 'groupImpact').mockResolvedValue(IMPACT_COSMETIC)

    selectGroupSection(container, 'Connection')

    // Change the port default to trigger impact computation
    const portInput = container.querySelector('#group-default-port') as HTMLInputElement
    expect(portInput).toBeTruthy()
    fireEvent.input(portInput, { target: { value: '22' } })

    // Wait for the impact summary to appear
    await vi.waitFor(() => {
      const count = container.querySelector('.cm-impact-count')
      expect(count).toBeTruthy()
      expect(count!.textContent).toContain('Affects')
    })

    expect(impactSpy).toHaveBeenCalled()
  })

  it('dangerous change gates the save button', async () => {
    const { container, client } = mount({
      profiles: MOCK_PROFILES,
      groups: MOCK_GROUPS,
    })
    await waitForProfiles(container, 3)

    await openGroupEditorByName(container, 'Production')

    const impactSpy = vi.spyOn(client, 'groupImpact').mockResolvedValue(IMPACT_DANGEROUS)

    selectGroupSection(container, 'Connection')

    // Change a default to trigger impact computation
    const portInput = container.querySelector('#group-default-port') as HTMLInputElement
    expect(portInput).toBeTruthy()
    fireEvent.input(portInput, { target: { value: '22' } })

    // Wait for dangerous badge to appear
    await vi.waitFor(() => {
      expect(container.querySelector('.cm-impact-danger-badge')).toBeTruthy()
    })

    // Scope to the group editor dialog
    const groupDialog = findDialogByTitle(container, 'Edit Group: Production')!

    // Save button should be disabled before confirmation
    const saveBtn = Array.from(groupDialog.querySelectorAll('.ui-button')).find(
      (b) => b.textContent?.trim() === 'Save Group',
    )
    expect(saveBtn).toBeTruthy()
    expect((saveBtn! as HTMLButtonElement).disabled).toBe(true)

    // Click the danger confirmation checkbox
    const confirmCheckbox = groupDialog.querySelector(
      '.cm-danger-confirm input[type="checkbox"]',
    ) as HTMLInputElement
    expect(confirmCheckbox).toBeTruthy()
    fireEvent.click(confirmCheckbox)

    // Save button should now be enabled
    await vi.waitFor(() => {
      expect((saveBtn! as HTMLButtonElement).disabled).toBe(false)
    })

    expect(impactSpy).toHaveBeenCalled()
  })

  it('cosmetic change does not gate the save', async () => {
    const { container, client } = mount({
      profiles: MOCK_PROFILES,
      groups: MOCK_GROUPS,
    })
    await waitForProfiles(container, 3)

    await openGroupEditorByName(container, 'Production')

    const impactSpy = vi.spyOn(client, 'groupImpact').mockResolvedValue(IMPACT_COSMETIC)

    selectGroupSection(container, 'Connection')

    // Change a non-dangerous default
    const portInput = container.querySelector('#group-default-port') as HTMLInputElement
    expect(portInput).toBeTruthy()
    fireEvent.input(portInput, { target: { value: '22' } })

    // Wait for impact to appear
    await vi.waitFor(() => {
      expect(container.querySelector('.cm-impact-count')).toBeTruthy()
    })

    const groupDialog = findDialogByTitle(container, 'Edit Group: Production')!

    // No danger confirmation checkbox should exist
    expect(groupDialog.querySelector('.cm-danger-confirm')).toBeFalsy()

    // Save button should be enabled
    const saveBtn = Array.from(groupDialog.querySelectorAll('.ui-button')).find(
      (b) => b.textContent?.trim() === 'Save Group',
    )
    expect(saveBtn).toBeTruthy()
    expect((saveBtn! as HTMLButtonElement).disabled).toBe(false)

    expect(impactSpy).toHaveBeenCalled()
  })

  it('cancelling the editor applies nothing', async () => {
    const { container, client } = mount({
      profiles: MOCK_PROFILES,
      groups: MOCK_GROUPS,
    })
    await waitForProfiles(container, 3)

    await openGroupEditorByName(container, 'Production')

    const applySpy = vi.spyOn(client, 'groupApply')

    // Find Cancel inside the group editor dialog
    const groupDialog = findDialogByTitle(container, 'Edit Group: Production')
    expect(groupDialog, 'Group dialog not found').toBeTruthy()
    const cancelBtn = Array.from(groupDialog!.querySelectorAll('.ui-button')).find(
      (b) => b.textContent?.trim() === 'Cancel',
    )
    expect(cancelBtn).toBeTruthy()
    ;(cancelBtn! as HTMLElement).click()

    // The group dialog should close
    await vi.waitFor(() => {
      expect(findDialogByTitle(container, 'Edit Group: Production')).toBeFalsy()
    })

    // groupApply should never be called
    expect(applySpy).not.toHaveBeenCalled()
  })

  it('delete states what happens to children before confirming', async () => {
    const { container, client } = mount({
      profiles: MOCK_PROFILES,
      groups: MOCK_GROUPS,
    })
    await waitForProfiles(container, 3)

    // Spy BEFORE clicking delete — computeDeleteImpact calls groupImpact immediately
    const impactSpy = vi.spyOn(client, 'groupImpact').mockResolvedValue(IMPACT_DELETE_PROMOTE)

    // Find and click the Delete button in the Production group header
    const headers = container.querySelectorAll('.cm-group-header')
    const prodHeader = Array.from(headers).find(
      (h) => h.querySelector('.cm-group-name')?.textContent === 'Production',
    )
    expect(prodHeader).toBeTruthy()
    const deleteBtn = prodHeader!.querySelector('[aria-label="Delete group Production"]')
    expect(deleteBtn).toBeTruthy()
    ;(deleteBtn! as HTMLElement).click()

    // Wait for delete dialog. Matched loosely: the title now names the group
    // it is about to destroy, which is the point of the confirmation.
    await vi.waitFor(() => {
      expect(findDialogByTitleContaining(container, 'Delete Group')).toBeTruthy()
    })

    const deleteDialog = findDialogByTitleContaining(container, 'Delete Group')!
    expect(deleteDialog.textContent).toContain('Production')

    // The impact should explain what happens to children
    await vi.waitFor(() => {
      const deleteText = deleteDialog.querySelector('.cm-delete-impact')
      expect(deleteText).toBeTruthy()
      expect(deleteText!.textContent).toContain('reparented')
      expect(deleteText!.textContent).toContain('child profiles')
    })

    expect(impactSpy).toHaveBeenCalled()
  })
})

// ── Move preview test ────────────────────────────────────────────────────

describe('profile move preview', () => {
  it('moving a profile into a group with different defaults previews the diff', async () => {
    const { container, client } = mount({
      profiles: MOCK_PROFILES,
      groups: MOCK_GROUPS,
    })
    await waitForProfiles(container, 3)

    // Open the profile editor for prod-db (which is in the Production group)
    await openProfileEditor(container, 'prod-db')

    // The profile form should be visible
    expect(container.querySelector('.cm-form')).toBeTruthy()

    const profileDialog = findDialogByTitleContaining(container, 'prod-db')
    expect(profileDialog, 'Profile dialog not found').toBeTruthy()

    // Find the Group select: label[for="profile-group"] inside the dialog
    const groupLabel = profileDialog!.querySelector('label[for="profile-group"]')
    expect(groupLabel, 'Group label not found').toBeTruthy()
    const groupSelect = groupLabel!
      .closest('.ui-field')
      ?.querySelector('.ui-select') as HTMLSelectElement
    expect(groupSelect, 'Group select not found in profile dialog').toBeTruthy()

    // Mock moveImpact to return a result
    const moveImpactSpy = vi.spyOn(client, 'moveImpact').mockResolvedValue(IMPACT_COSMETIC)

    // Change the group to empty (ungrouped) to trigger moveImpact
    fireEvent.change(groupSelect, { target: { value: '' } })

    // Wait for the move impact preview to appear (reuses renderImpactSummary)
    await vi.waitFor(() => {
      const count = container.querySelector('.cm-impact-count')
      expect(count).toBeTruthy()
      expect(count!.textContent).toContain('Affects')
    })

    expect(moveImpactSpy).toHaveBeenCalledWith({
      profileIds: ['ssh:p2'],
      targetGroupId: '',
    })
  })
})
