// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import { CredentialsSection } from './credentials'
import { ProfileClient } from './profiles'
import { Dispatcher } from './dispatcher'
import type { Credential, CredentialUsage } from './profiles'

// ── Stub data ───────────────────────────────────────────────────────────

const MOCK_CRED_1: Credential = {
  id: 'cred:prod-deploy',
  name: 'prod-deploy',
  username: 'deploy',
  auth: 'password',
}

const MOCK_CRED_2: Credential = {
  id: 'cred:dev-admin',
  name: 'dev-admin',
  username: 'admin',
  auth: 'publicKey',
  keyPath: '/home/user/.ssh/id_rsa',
}

const MOCK_USAGE: CredentialUsage[] = [
  {
    credentialId: 'cred:prod-deploy',
    profiles: [{ profileId: 'p1', profileName: 'prod-web', source: 'profile' }],
  },
  {
    credentialId: 'cred:dev-admin',
    profiles: [],
  },
]

// ── Mock helpers ────────────────────────────────────────────────────────

function createMockClient() {
  const pc = new ProfileClient(new Dispatcher())

  vi.spyOn(pc, 'listCredentials').mockResolvedValue([MOCK_CRED_1, MOCK_CRED_2])
  vi.spyOn(pc, 'credentialUsage').mockResolvedValue({ usage: MOCK_USAGE })
  const createSpy = vi
    .spyOn(pc, 'createCredential')
    .mockImplementation((c: Credential) =>
      Promise.resolve({ ...c, id: 'cred:backend-assigned-id' }),
    )
  const updateSpy = vi
    .spyOn(pc, 'updateCredential')
    .mockImplementation((c: Credential) => Promise.resolve(c))
  vi.spyOn(pc, 'deleteCredential').mockResolvedValue(true)
  const savePwdSpy = vi.spyOn(pc, 'savePassword').mockResolvedValue(true)

  return { client: pc, createSpy, updateSpy, savePwdSpy }
}

function mount() {
  const { client, ...spies } = createMockClient()
  const container = document.body.appendChild(document.createElement('div'))
  render(() => <CredentialsSection client={client} />, { container })
  return { container, client, ...spies }
}

afterEach(() => {
  vi.clearAllMocks()
  cleanup()
})

// ── List tests ─────────────────────────────────────────────────────────

describe('CredentialsSection — list', () => {
  it('loads and renders credentials from the backend', async () => {
    const { container } = mount()
    await vi.waitFor(() => {
      expect(container.querySelector('.cr-item-name')).toBeTruthy()
    })
    const names = container.querySelectorAll('.cr-item-name')
    expect(names.length).toBe(2)
    expect(names[0].textContent).toBe('prod-deploy')
    expect(names[1].textContent).toBe('dev-admin')
  })

  it('shows usage in subtitle (N connections)', async () => {
    const { container } = mount()
    await vi.waitFor(() => {
      expect(container.querySelector('.cr-item-meta')).toBeTruthy()
    })
    const metas = container.querySelectorAll('.cr-item-meta')
    expect(metas[0].textContent).toContain('1 connection')
    expect(metas[1].textContent).toContain('not used by anything')
  })

  it('shows empty state when credentials list is empty', async () => {
    const pc = new ProfileClient(new Dispatcher())
    vi.spyOn(pc, 'listCredentials').mockResolvedValue([])
    vi.spyOn(pc, 'credentialUsage').mockResolvedValue({ usage: [] })
    const container = document.body.appendChild(document.createElement('div'))
    render(() => <CredentialsSection client={pc} />, { container })
    await vi.waitFor(() => {
      expect(container.querySelector('.ui-empty-state')).toBeTruthy()
    })
  })
})

// ── Edit flow (duplicate-on-edit fix) ──────────────────────────────────

describe('CredentialsSection — edit mutates in place', () => {
  it('edit calls updateCredential (not createCredential) and list length stays the same', async () => {
    const { container, updateSpy, createSpy } = mount()
    await vi.waitFor(() => {
      expect(container.querySelector('.cr-item-name')).toBeTruthy()
    })

    // Record list length before
    const namesBefore = container.querySelectorAll('.cr-item-name')
    expect(namesBefore.length).toBe(2)

    // Click the first row's Edit button. The row itself is deliberately not a
    // click target — see the comment in credentials.tsx — so this test is also
    // what stops a keyboard-unreachable row click coming back.
    const firstRowActions = container.querySelectorAll('.cr-item-actions')[0]
    const editBtn = Array.from(firstRowActions.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Edit',
    )
    expect(editBtn).toBeTruthy()
    editBtn?.click()

    await vi.waitFor(() => {
      expect(container.querySelector('.nocx-dialog__panel')).toBeTruthy()
    })

    // Should say "Edit Credential" in the title
    expect(container.querySelector('.nocx-dialog__title')?.textContent).toBe('Edit Credential')

    // Click the "Save Credential" button in the footer
    const actions = container.querySelector('.nocx-dialog__actions')
    const saveBtns = actions?.querySelectorAll('.ui-button')
    const saveBtn = Array.from(saveBtns ?? []).find(
      (b) => b.textContent === 'Save Credential',
    ) as HTMLElement
    expect(saveBtn).toBeTruthy()
    saveBtn.click()

    // Verify: updateCredential was called, createCredential was NOT called
    expect(createSpy).not.toHaveBeenCalled()
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'cred:prod-deploy' }))
  })
})

// ── Create flow ────────────────────────────────────────────────────────

describe('CredentialsSection — create flow', () => {
  it('create calls createCredential and savePassword uses the returned id', async () => {
    const { container, createSpy, savePwdSpy } = mount()
    await vi.waitFor(() => {
      expect(container.querySelector('.cr-item-name')).toBeTruthy()
    })

    // Click "+ New credential"
    const newBtn = container.querySelector('.cr-toolbar .ui-button') as HTMLElement
    expect(newBtn).toBeTruthy()
    newBtn.click()

    await vi.waitFor(() => {
      expect(container.querySelector('.nocx-dialog__panel')).toBeTruthy()
    })

    // Title should say "New Credential"
    expect(container.querySelector('.nocx-dialog__title')?.textContent).toBe('New Credential')

    // Fill the form fields by setting values and dispatching input events
    const nameInput = document.getElementById('cred-name') as HTMLInputElement
    const userInput = document.getElementById('cred-username') as HTMLInputElement
    expect(nameInput).toBeTruthy()
    expect(userInput).toBeTruthy()

    nameInput.value = 'new-cred'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    userInput.value = 'ops'
    userInput.dispatchEvent(new Event('input', { bubbles: true }))

    // Select password auth by clicking the first radio
    const radios = container.querySelectorAll('input[type="radio"]')
    expect(radios.length).toBeGreaterThanOrEqual(1)
    ;(radios[0] as HTMLElement).click()

    // Fill password
    const pwdInput = document.getElementById('cred-password') as HTMLInputElement | null
    if (pwdInput) {
      pwdInput.value = 's3cret'
      pwdInput.dispatchEvent(new Event('input', { bubbles: true }))
    }

    // Find and click the "Create Credential" button
    const actions = container.querySelector('.nocx-dialog__actions')
    const btns = actions?.querySelectorAll('.ui-button') ?? []
    const createBtn = Array.from(btns).find(
      (b) => b.textContent === 'Create Credential',
    ) as HTMLElement
    expect(createBtn).toBeTruthy()
    createBtn.click()

    // Verify: createCredential was called with the credential data
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-cred', username: 'ops' }),
    )

    // Verify: savePassword was called with the backend-returned id, NOT the form's empty id
    await vi.waitFor(() => {
      expect(savePwdSpy).toHaveBeenCalledWith('cred:backend-assigned-id', expect.any(String))
    })
  })
})
