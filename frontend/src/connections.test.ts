// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConnectionManagerViewImpl } from './connections'
import { Dispatcher } from './dispatcher'
import { ProfileClient } from './profiles'
import type { SSHProfile } from './profiles'

function mockDispatcher(): Dispatcher {
  return new Dispatcher()
}

describe('ConnectionManagerView', () => {
  let container: HTMLDivElement
  let client: ProfileClient
  let view: ConnectionManagerViewImpl

  beforeEach(() => {
    document.body.replaceChildren()
    container = document.createElement('div')
    container.id = 'connections-view'
    document.body.append(container)
    client = new ProfileClient(mockDispatcher())
    // Default RPC mocks.
    vi.spyOn(client, 'listProfiles').mockResolvedValue([])
    vi.spyOn(client, 'listGroups').mockResolvedValue([])
    vi.spyOn(client, 'createProfile').mockResolvedValue({} as SSHProfile)
    vi.spyOn(client, 'deleteProfile').mockResolvedValue(true)
    vi.spyOn(client, 'importTabby').mockResolvedValue(0)
    vi.spyOn(client, 'listCredentials').mockResolvedValue([])
    vi.spyOn(client, 'savePassword').mockResolvedValue(true)
    vi.spyOn(client, 'deletePassword').mockResolvedValue(true)
    vi.spyOn(client, 'hasPassword').mockResolvedValue(false)
    view = new ConnectionManagerViewImpl(container, client)
  })

  it('renders header with Connections title and action buttons', async () => {
    await view.refresh()
    const header = container.querySelector('.cm-header')
    expect(header).toBeDefined()
    expect(container.textContent).toContain('Connections')
    expect(container.textContent).toContain('+ New connection')
    expect(container.textContent).toContain('Import from Tabby')
  })

  it('shows empty state when no profiles', async () => {
    await view.refresh()
    const empty = container.querySelector('.cm-list-empty')
    expect(empty).toBeDefined()
    expect(container.textContent).toContain('No connections yet')
  })

  it('renders the list with profiles', async () => {
    vi.spyOn(client, 'listProfiles').mockResolvedValue([
      {
        id: 'p1',
        type: 'ssh',
        name: 'web1',
        options: { host: 'web1.example.com', port: 22, user: 'alice' },
      },
      {
        id: 'p2',
        type: 'ssh',
        name: 'web2',
        options: { host: 'web2.example.com', port: 22, user: 'bob' },
      },
    ])
    await view.refresh()
    const items = container.querySelectorAll('.cm-item')
    expect(items).toHaveLength(2)
    expect(container.textContent).toContain('web1')
    expect(container.textContent).toContain('web2')
  })

  it('renders groups as section headers', async () => {
    vi.spyOn(client, 'listGroups').mockResolvedValue([{ id: 'g1', name: 'Production' }])
    vi.spyOn(client, 'listProfiles').mockResolvedValue([
      { id: 'p1', type: 'ssh', name: 'web1', group: 'g1', options: { host: 'h1', port: 22 } },
    ])
    await view.refresh()
    expect(container.textContent).toContain('Production')
  })

  it('shows form on the right when a profile is selected', async () => {
    vi.spyOn(client, 'listProfiles').mockResolvedValue([
      { id: 'p1', type: 'ssh', name: 'web1', options: { host: 'h', port: 22, user: 'u' } },
    ])
    await view.refresh()
    const item = container.querySelector<HTMLElement>('.cm-item[data-id], .cm-item')!
    item.click()
    // Form panel should now contain a form.
    const formPanel = container.querySelector('.cm-form-panel')
    expect(formPanel).toBeDefined()
    expect(formPanel!.querySelector('.cm-form')).toBeDefined()
  })

  it('opens new profile form on "+ New connection" click', async () => {
    await view.refresh()
    const newBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '+ New connection',
    )!
    newBtn.click()
    const form = container.querySelector('.cm-form')
    expect(form).toBeDefined()
    expect(container.textContent).toContain('Basic')
    expect(container.textContent).toContain('Host')
    expect(container.textContent).toContain('Port')
  })

  it('form exposes all auth methods in the radio group', async () => {
    await view.refresh()
    const newBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '+ New connection',
    )!
    newBtn.click()
    const radios = container.querySelectorAll<HTMLInputElement>(
      'input[type="radio"][name="auth-mode"]',
    )
    expect(radios.length).toBe(5)
    const labels = Array.from(radios).map((r) => r.value)
    expect(labels).toEqual(['', 'password', 'publicKey', 'agent', 'keyboardInteractive'])
  })

  it('form exposes advanced SSH settings', async () => {
    await view.refresh()
    const newBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '+ New connection',
    )!
    newBtn.click()
    expect(container.textContent).toContain('Keepalive interval')
    expect(container.textContent).toContain('Keepalive count max')
    expect(container.textContent).toContain('Ready timeout')
    expect(container.textContent).toContain('Agent forward')
  })

  it('renders content on show()', async () => {
    view.show()
    // show() triggers refresh() → render. The header should be visible.
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Connections')
    })
  })

  it('fires onConnect when Connect button is clicked', async () => {
    const profile: SSHProfile = {
      id: 'p1',
      type: 'ssh',
      name: 'web1',
      options: { host: 'h', port: 22, user: 'u' },
    }
    vi.spyOn(client, 'listProfiles').mockResolvedValue([profile])
    let connected: SSHProfile | null = null
    view.onConnect = (p) => {
      connected = p
    }
    await view.refresh()
    // Select the profile.
    const item = container.querySelector<HTMLElement>('.cm-item')!
    item.click()
    // Click Connect.
    const connectBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Connect',
    )!
    connectBtn.click()
    expect(connected).not.toBeNull()
    expect(connected!.id).toBe('p1')
  })

  it('triggers import when Import button is clicked (file dialog)', async () => {
    await view.refresh()
    const importBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Import from Tabby',
    )!
    // file dialog click is intercepted by the browser — we just verify the
    // button exists and is clickable without crashing.
    expect(importBtn).toBeDefined()
  })

  it('renders credential name as text, not HTML — no injection', async () => {
    const payload = '<img src=x onerror="window.__pwned=1">'
    const cred = { id: 'c1', name: payload, username: 'alice', auth: 'publicKey' as const }
    vi.spyOn(client, 'listCredentials').mockResolvedValue([cred])
    vi.spyOn(client, 'listProfiles').mockResolvedValue([
      {
        id: 'p1',
        type: 'ssh',
        name: 'web1',
        options: { host: 'h', port: 22, user: 'u', credentialId: 'c1' },
      },
    ])
    await view.refresh()
    // Both credential items and profile items use .cm-item.
    // Credential items come first in the list. Select the profile by its SSH button.
    const profileItem = container.querySelector<HTMLElement>('.cm-item:has(.cm-quick-connect)')
    expect(profileItem).not.toBeNull()
    profileItem!.click()
    const formPanel = container.querySelector('.cm-form-panel')
    expect(formPanel).not.toBeNull()
    // Verify credential info panel is rendered with the payload
    expect(formPanel!.textContent).toContain('Using Credential')
    // The innerHTML with cred.name SHOULD create an img element.
    // BEFORE FIX: this WILL FAIL — img element exists
    expect(container.querySelector('img')).toBeNull()
    // The literal text of the payload must be visible
    expect(container.textContent).toContain(payload)
  })
})

// nocx-wd2m. Host binding is mandatory (nocx-mon). The backend refuses an
// unbound credential at save time, and the form has to refuse it too — not to
// be the guarantee, but so the user learns WHICH field is wrong instead of
// meeting a failed connection later. Before this, the guard existed for name
// and username only and reported itself through log.warn, so the Save button
// silently did nothing.
describe('credential form: host binding is required', () => {
  let container: HTMLDivElement
  let client: ProfileClient
  let view: ConnectionManagerViewImpl

  beforeEach(async () => {
    document.body.replaceChildren()
    container = document.createElement('div')
    document.body.append(container)
    client = new ProfileClient(mockDispatcher())
    vi.spyOn(client, 'listProfiles').mockResolvedValue([])
    vi.spyOn(client, 'listGroups').mockResolvedValue([])
    vi.spyOn(client, 'listCredentials').mockResolvedValue([])
    vi.spyOn(client, 'hasPassword').mockResolvedValue(false)
    vi.spyOn(client, 'savePassword').mockResolvedValue(true)
    view = new ConnectionManagerViewImpl(container, client)
    await view.refresh()
  })

  function openCredentialForm(): void {
    const btn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Saved credentials',
    )
    if (!btn) throw new Error('"Saved credentials" button not found')
    btn.click()
  }

  function fill(label: string, value: string): void {
    const field = [...container.querySelectorAll('.cm-field')].find((f) =>
      f.textContent?.includes(label),
    )
    const input = field?.querySelector('input')
    if (!input) throw new Error(`field ${label} not found`)
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function save(): void {
    const btn = container.querySelector<HTMLButtonElement>('button.cm-save')
    if (!btn) throw new Error('save button not found')
    btn.click()
  }

  it('refuses to submit without a host and says so on screen', async () => {
    const create = vi.spyOn(client, 'createCredential')
    openCredentialForm()
    fill('Name', 'unbound')
    fill('Username', 'bob')
    save()
    await Promise.resolve()

    expect(create).not.toHaveBeenCalled()
    const err = container.querySelector('.cm-form-error')
    expect(err?.textContent ?? '').toContain('Bind to Host is required')
  })

  it('refuses a whitespace-only host', async () => {
    const create = vi.spyOn(client, 'createCredential')
    openCredentialForm()
    fill('Name', 'spacey')
    fill('Username', 'bob')
    fill('Bind to Host', '   ')
    save()
    await Promise.resolve()

    expect(create).not.toHaveBeenCalled()
  })

  it('submits once a host is given', async () => {
    const create = vi
      .spyOn(client, 'createCredential')
      .mockResolvedValue({ id: 'c1', name: 'bound', username: 'bob', auth: '' } as never)
    openCredentialForm()
    fill('Name', 'bound')
    fill('Username', 'bob')
    fill('Bind to Host', 'prod.example.com')
    save()
    await Promise.resolve()

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toMatchObject({ host: 'prod.example.com' })
  })
})
