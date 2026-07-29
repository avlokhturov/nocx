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
import { cleanup, render } from '@solidjs/testing-library'
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
      (c) => c.matches('.cm-group-header') && c.textContent === 'Production',
    )
    const connectionsIdx = children.findIndex(
      (c) => c.matches('.cm-group-header') && c.textContent === 'Connections',
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
