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
import type {
  SSHProfile,
  ProfileGroup,
  Credential,
  EffectiveProfileDTO,
  SessionStatus,
  ConnectionTestResult,
  GroupImpactResponse,
} from './profiles'
// ── Stub profiles ──────────────────────────────────────────────────────

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

    const items = container.querySelectorAll('.cm-item')
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
  it('calls connectionTest and displays the typed outcome', async () => {
    const onConnect = vi.fn()
    const { container, connectionTest } = mount({
      profiles: MOCK_PROFILES.slice(0, 1),
      onConnect,
      connectionTestResult: { outcome: 'rejected', detail: 'Password authentication failed' },
    })

    await waitForProfiles(container, 1)

    const allBtns = container.querySelectorAll('.cm-item-actions .ui-button')
    const testBtn = Array.from(allBtns).find((b) => b.textContent?.trim() === 'Test')
    expect(testBtn, 'Test button not found').toBeTruthy()
    ;(testBtn! as HTMLElement).click()

    await vi.waitFor(() => {
      const badges = container.querySelectorAll('.ui-badge')
      expect(badges.length).toBeGreaterThanOrEqual(2)
      expect(badges[1].textContent).toBe('Rejected')
    })

    const detail = container.querySelector('.cm-probe-detail')
    expect(detail).toBeTruthy()
    expect(detail!.textContent).toContain('Password authentication failed')

    expect(onConnect).not.toHaveBeenCalled()

    expect(connectionTest).toHaveBeenCalledWith('ssh:p1')
  })

  it('displays accepted outcome as success', async () => {
    const { container } = mount({
      profiles: MOCK_PROFILES.slice(0, 1),
      connectionTestResult: { outcome: 'accepted', detail: 'Connection successful' },
    })

    await waitForProfiles(container, 1)

    const allBtns = container.querySelectorAll('.cm-item-actions .ui-button')
    const testBtn = Array.from(allBtns).find((b) => b.textContent?.trim() === 'Test')
    expect(testBtn, 'Test button not found').toBeTruthy()
    ;(testBtn! as HTMLElement).click()

    await vi.waitFor(() => {
      const badges = container.querySelectorAll('.ui-badge')
      expect(badges.length).toBeGreaterThanOrEqual(2)
      expect(badges[1].textContent).toBe('Accepted')
    })

    const detail = container.querySelector('.cm-probe-detail')
    expect(detail).toBeTruthy()
    expect(detail!.textContent).toContain('Connection successful')
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

    await vi.waitFor(() => {
      const items = container.querySelectorAll('.cm-item-credential')
      expect(items.length).toBeGreaterThanOrEqual(1)
    })

    const credSection = container.querySelector('.cm-item-credential')
    expect(credSection).toBeTruthy()
    const credBtns = credSection!.querySelectorAll('.ui-button')
    const credBtn = Array.from(credBtns).find((b) => b.textContent?.trim() === 'prod-key')
    expect(credBtn, 'Credential button not found').toBeTruthy()
    ;(credBtn! as HTMLElement).click()

    expect(onNavigateToCredentials).toHaveBeenCalledTimes(1)
  })
})

// ── Editing opens the dialog ──────────────────────────────────────────

describe('edit action', () => {
  it('clicking Edit opens the dialog editor (not an inline editor)', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })

    await waitForProfiles(container, 1)

    const allBtns = container.querySelectorAll('.cm-item-actions .ui-button')
    const editBtn = Array.from(allBtns).find((b) => b.textContent?.trim() === 'Edit')
    expect(editBtn, 'Edit button not found').toBeTruthy()
    ;(editBtn! as HTMLElement).click()

    await vi.waitFor(() => {
      const panel = container.querySelector('.nocx-dialog__panel')
      expect(panel).toBeTruthy()
    })

    const title = container.querySelector('.nocx-dialog__title')
    expect(title).toBeTruthy()
    expect(title!.textContent).toBe('Edit Connection: prod-web')
  })

  it('the list is still present with the dialog open', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })

    await waitForProfiles(container, 1)

    const allBtns = container.querySelectorAll('.cm-item-actions .ui-button')
    const editBtn = Array.from(allBtns).find((b) => b.textContent?.trim() === 'Edit')
    expect(editBtn, 'Edit button not found').toBeTruthy()
    ;(editBtn! as HTMLElement).click()

    await vi.waitFor(() => {
      expect(container.querySelector('.nocx-dialog__panel')).toBeTruthy()
    })

    expect(container.querySelectorAll('.cm-item').length).toBe(1)
    expect(container.querySelector('.cm-body')).toBeTruthy()
  })
})

// ── Groups render as a tree ────────────────────────────────────────────

describe('group tree', () => {
  it('a profile assigned to a group appears under that group header in DOM order', async () => {
    const { container } = mount({
      profiles: MOCK_PROFILES,
      groups: MOCK_GROUPS,
    })

    await waitForProfiles(container, 3)

    const body = container.querySelector('.cm-body')
    expect(body).toBeTruthy()
    const children = Array.from(body!.children)

    const productionIdx = children.findIndex(
      (c) =>
        c.matches('.cm-group-header') &&
        c.querySelector('.cm-group-name')?.textContent === 'Production',
    )
    const connectionsIdx = children.findIndex(
      (c) =>
        c.matches('.cm-group-header') &&
        c.querySelector('.cm-group-name')?.textContent === 'Connections',
    )
    const prodDbIdx = children.findIndex(
      (c) => c.matches('.cm-item') && c.querySelector('.cm-item-name')?.textContent === 'prod-db',
    )
    const prodWebIdx = children.findIndex(
      (c) => c.matches('.cm-item') && c.querySelector('.cm-item-name')?.textContent === 'prod-web',
    )
    const stagingIdx = children.findIndex(
      (c) =>
        c.matches('.cm-item') && c.querySelector('.cm-item-name')?.textContent === 'staging-web',
    )

    expect(productionIdx).toBeGreaterThanOrEqual(0)
    expect(connectionsIdx).toBeGreaterThanOrEqual(0)
    expect(prodDbIdx).toBeGreaterThanOrEqual(0)

    expect(prodDbIdx).toBeGreaterThan(productionIdx)
    expect(prodDbIdx).toBeLessThan(connectionsIdx)
    expect(prodWebIdx).toBeGreaterThan(connectionsIdx)
    expect(stagingIdx).toBeGreaterThan(connectionsIdx)
  })

  it('empty tree sections are omitted (no group header for zero-profile groups)', async () => {
    const { container } = mount({
      profiles: MOCK_PROFILES.slice(0, 1),
      groups: MOCK_GROUPS,
    })

    await waitForProfiles(container, 1)

    const headers = container.querySelectorAll('.cm-group-header')
    expect(headers.length).toBe(1)
    expect(headers[0].textContent).toBe('Connections')
  })
})

// ── Quick-connect dialog (creation from one field) ────────────────────────

describe('quick connect', () => {
  it('"+ New connection" opens the quick-connect dialog, not the full form', async () => {
    const { container } = mount({ profiles: [] })

    await waitForProfiles(container, 0)

    // Find and click the "+ New connection" button
    const newBtn = container.querySelector('.ui-button')
    expect(newBtn, 'New connection button not found').toBeTruthy()
    expect(newBtn!.textContent).toContain('New connection')
    ;(newBtn! as HTMLElement).click()

    // Quick-connect dialog should appear
    await vi.waitFor(() => {
      const input = container.querySelector('#quick-connect-input')
      expect(input).toBeTruthy()
    })

    // The full form dialog should NOT be open yet (no profile-name field)
    expect(container.querySelector('#profile-name')).toBeFalsy()
  })

  it('typing a connection string and clicking Next opens the form with parsed values', async () => {
    const { container } = mount({ profiles: [] })

    await waitForProfiles(container, 0)

    // Click "+ New connection"
    const newBtn = container.querySelector('.ui-button')
    expect(newBtn).toBeTruthy()
    ;(newBtn! as HTMLElement).click()

    // Type into the quick-connect input
    await vi.waitFor(() => {
      const input = container.querySelector('#quick-connect-input') as HTMLInputElement
      expect(input).toBeTruthy()
    })

    const input = container.querySelector('#quick-connect-input') as HTMLInputElement
    input.value = 'deploy@web.example.com:2222'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Click "Next"
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

    const userInput = container.querySelector('#profile-user') as HTMLInputElement
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
  it('a "+" button sits beside the credential select in the form', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })

    await waitForProfiles(container, 1)

    // Open edit dialog
    const editBtn = Array.from(container.querySelectorAll('.cm-item-actions .ui-button')).find(
      (b) => b.textContent?.trim() === 'Edit',
    )
    expect(editBtn).toBeTruthy()
    ;(editBtn! as HTMLElement).click()

    await vi.waitFor(() => {
      expect(container.querySelector('.nocx-dialog__panel')).toBeTruthy()
    })

    // Find the "+" button beside the credential select
    const plusBtn = container.querySelector('[aria-label="New credential"]')
    expect(plusBtn, 'New credential button not found beside credential select').toBeTruthy()
  })

  it('clicking the "+" button opens a credential creation dialog', async () => {
    const { container } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })

    await waitForProfiles(container, 1)

    // Open edit dialog
    const editBtn = Array.from(container.querySelectorAll('.cm-item-actions .ui-button')).find(
      (b) => b.textContent?.trim() === 'Edit',
    )
    expect(editBtn).toBeTruthy()
    ;(editBtn! as HTMLElement).click()

    await vi.waitFor(() => {
      expect(container.querySelector('.nocx-dialog__panel')).toBeTruthy()
    })

    // Click "+"
    const plusBtn = container.querySelector('[aria-label="New credential"]') as HTMLElement
    expect(plusBtn).toBeTruthy()
    plusBtn.click()

    // Credential dialog should appear
    await vi.waitFor(() => {
      const credNameInput = container.querySelector('#cred-name') as HTMLInputElement
      expect(credNameInput, 'Credential form did not open').toBeTruthy()
      expect(credNameInput.value).toBe('')
    })
  })

  it('creating a credential from the form selects it and keeps the connection intact', async () => {
    const { container, client } = mount({ profiles: MOCK_PROFILES.slice(0, 1) })

    // Spy on createCredential to return a canned credential
    const newCred: Credential = {
      id: 'cred:new-key',
      name: 'prod-key-2',
      username: 'deploy',
      auth: 'publicKey',
      keyPath: '/home/user/.ssh/id_rsa',
    }
    const createSpy = vi.spyOn(client, 'createCredential').mockResolvedValue(newCred)
    vi.spyOn(client, 'listCredentials').mockResolvedValue([...MOCK_CREDENTIALS, newCred])

    await waitForProfiles(container, 1)

    // Open edit dialog
    const editBtn = Array.from(container.querySelectorAll('.cm-item-actions .ui-button')).find(
      (b) => b.textContent?.trim() === 'Edit',
    )
    expect(editBtn).toBeTruthy()
    fireEvent.click(editBtn!)

    await vi.waitFor(() => {
      expect(container.querySelector('.nocx-dialog__panel')).toBeTruthy()
    })

    // Save the connection form's host value before opening credential dialog
    const origHostValue = (container.querySelector('#profile-host') as HTMLInputElement)?.value

    // Click "+" beside credential select
    const plusBtn = container.querySelector('[aria-label="New credential"]') as HTMLElement
    expect(plusBtn).toBeTruthy()
    fireEvent.click(plusBtn)

    // Fill in credential name
    await vi.waitFor(() => {
      const credNameInput = container.querySelector('#cred-name') as HTMLInputElement
      expect(credNameInput, 'Credential form should open').toBeTruthy()
    })

    const nameInput = container.querySelector('#cred-name') as HTMLInputElement
    fireEvent.input(nameInput, { target: { value: 'prod-key-2' } })

    const usernameInput = container.querySelector('#cred-username') as HTMLInputElement
    fireEvent.input(usernameInput, { target: { value: 'deploy' } })

    // Find "Save Credential" first, then click once
    const saveBtn = await vi.waitFor(() => {
      const btn = Array.from(container.querySelectorAll('.ui-button')).find(
        (b) => b.textContent?.trim() === 'Save Credential',
      )
      expect(btn).toBeTruthy()
      return btn!
    })
    fireEvent.click(saveBtn)

    // Wait for the create call
    await vi.waitFor(() => {
      expect(createSpy).toHaveBeenCalled()
    })

    // Credential dialog should close
    await vi.waitFor(() => {
      expect(container.querySelector('#cred-name')).toBeFalsy()
    })

    // Connection form should still be open (profile-host still visible)
    expect(container.querySelector('#profile-host')).toBeTruthy()

    // The connection form's host value is preserved
    expect((container.querySelector('#profile-host') as HTMLInputElement).value).toBe(origHostValue)

    // The credential select has the new credential selected
    const credSelect = container.querySelector('.ui-select') as HTMLSelectElement
    expect(credSelect, 'Credential select element not found').toBeTruthy()
    expect(credSelect.value).toBe('cred:new-key')
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
  const editBtn = Array.from(targetHeader!.querySelectorAll('.cm-group-actions .ui-button')).find(
    (b) => b.textContent?.trim() === 'Edit',
  )
  expect(editBtn, `Edit button for "${groupName}" not found`).toBeTruthy()
  ;(editBtn! as HTMLElement).click()

  await vi.waitFor(() => {
    const dialog = findDialogByTitle(container, `Edit Group: ${groupName}`)
    expect(dialog, `Group edit dialog "${groupName}" not found`).toBeTruthy()
  })
}

// ── Helper: open the profile edit dialog for a named profile ─────────────

async function openProfileEditor(container: HTMLElement, profileName: string) {
  const allBtns = container.querySelectorAll('.cm-item-actions .ui-button')
  const editBtn = Array.from(allBtns).find((b) => b.textContent?.trim() === 'Edit')
  expect(editBtn, `Edit button for "${profileName}" not found`).toBeTruthy()
  ;(editBtn! as HTMLElement).click()

  await vi.waitFor(() => {
    const dialog = findDialogByTitleContaining(container, profileName)
    expect(dialog, `Profile edit dialog "${profileName}" not found`).toBeTruthy()
  })
}

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
    const deleteBtn = Array.from(prodHeader!.querySelectorAll('.cm-group-actions .ui-button')).find(
      (b) => b.textContent?.trim() === 'Delete',
    )
    expect(deleteBtn).toBeTruthy()
    ;(deleteBtn! as HTMLElement).click()

    // Wait for delete dialog
    await vi.waitFor(() => {
      expect(findDialogByTitle(container, 'Delete Group')).toBeTruthy()
    })

    const deleteDialog = findDialogByTitle(container, 'Delete Group')!

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
