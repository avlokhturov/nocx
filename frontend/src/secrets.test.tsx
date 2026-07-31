// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import { SecretsSection } from './secrets'
import { createVaultState } from './vault'
import type { VaultClient, VaultInventory, InventoryEntry } from './vault-client'

// ── jsdom patch: native <dialog> showModal/close are unsupported ──────
const origShowModal = HTMLDialogElement.prototype.showModal.bind(HTMLDialogElement.prototype)
const origClose = HTMLDialogElement.prototype.close.bind(HTMLDialogElement.prototype)

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn()
  HTMLDialogElement.prototype.close = vi.fn()
})

afterEach(() => {
  cleanup()
  HTMLDialogElement.prototype.showModal = origShowModal
  HTMLDialogElement.prototype.close = origClose
})

// ── Helpers ────────────────────────────────────────────────────────────

const SEALED_STATUS = {
  state: 'sealed' as const,
  osKeyAvailable: false,
  osKeyCapable: false,
  hasPassphrase: false,
  autoSealMinutes: 0,
  providers: [],
  defaultProvider: null,
}

function mockClient() {
  const status = vi.fn()
  const setup = vi.fn()
  const unseal = vi.fn()
  const seal = vi.fn()
  const changePassphrase = vi.fn()
  const regenerateRecovery = vi.fn()
  const setDefaultProvider = vi.fn()
  const setAutoSeal = vi.fn()
  const activity = vi.fn()
  const inventory = vi.fn<() => Promise<VaultInventory>>()
  const createSecret = vi.fn()
  const renameSecret = vi.fn()
  const client = {
    status,
    setup,
    unseal,
    seal,
    changePassphrase,
    regenerateRecovery,
    setDefaultProvider,
    setAutoSeal,
    activity,
    inventory,
    createSecret,
    renameSecret,
  } as unknown as VaultClient
  return { client, inventory, createSecret, renameSecret, status }
}

const UNSEALED_STATUS = {
  state: 'unsealed' as const,
  osKeyAvailable: true,
  osKeyCapable: true,
  hasPassphrase: true,
  autoSealMinutes: 0,
  providers: [],
  defaultProvider: null,
}

const MOCK_ENTRY_1: InventoryEntry = {
  id: 'secrow:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  kind: 'password',
  name: 'SSH password for deploy',
  provider: 'system',
  ownerId: 'cred:prod-deploy',
  usedBy: 12,
  reachable: true,
}

const MOCK_ENTRY_2: InventoryEntry = {
  id: 'secrow:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  kind: 'password',
  name: 'SSH password for shady@vm-dsm01:22',
  provider: 'system',
  ownerId: 'cred:shady',
  usedBy: 0,
  reachable: true,
}

/** Mount the SecretsSection with mocked client and controller. */
async function mount(client: VaultClient) {
  const ctrl = createVaultState(client)
  // Wait for the initial status fetch
  await ctrl.refresh()
  const container = document.body.appendChild(document.createElement('div'))
  render(() => <SecretsSection vaultClient={client} vaultController={ctrl} />, { container })
  return { container, ctrl }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('SecretsSection', () => {
  it('shows locked state when vault is sealed — no rows, no counts', async () => {
    const { client } = mockClient()
    client.status = vi.fn().mockResolvedValue(SEALED_STATUS)

    const { container } = await mount(client)

    // The locked state
    expect(container.querySelector('.ui-empty-state')).toBeTruthy()
    expect(container.querySelector('.ui-empty-state__title')?.textContent).toBe('Vault is locked')
    expect(container.querySelector('.ui-empty-state__action')).toBeTruthy()
    expect(container.querySelector('.ui-empty-state__action')?.textContent).toBe('Unlock vault')

    // No rows
    expect(container.querySelector('.sr-row-label')).toBeNull()
    // No usage count anywhere
    expect(container.textContent).not.toMatch(/\d+\s*connections?/)
    // "Sealed: a locked state and one action. Nothing else." — the surface spec
    // (.internal/specs/2026-07-30). A standing line of body copy above the
    // plate broke that rule and looked like it: a paragraph with no heading
    // over it and a centred plate floating underneath.
    expect(container.textContent).not.toMatch(/passwords and key passphrases/)
  })

  it('shows empty state when unsealed with no entries — different from sealed', async () => {
    const { client, inventory } = mockClient()
    client.status = vi.fn().mockResolvedValue(UNSEALED_STATUS)
    inventory.mockResolvedValue({ entries: [] })

    const { container } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.ui-empty-state')).toBeTruthy()
    })

    // Empty state with vault-empty message (different from sealed)
    const titles = container.querySelectorAll('.ui-empty-state__title')
    const emptyTitle = Array.from(titles).find((t) => t.textContent === 'Vault is empty')
    expect(emptyTitle).toBeTruthy()

    // No rows
    expect(container.querySelector('.sr-row-label')).toBeNull()
  })

  it('shows rows for each entry with label, store, and usage count', async () => {
    const { client, inventory } = mockClient()
    client.status = vi.fn().mockResolvedValue(UNSEALED_STATUS)
    inventory.mockResolvedValue({ entries: [MOCK_ENTRY_1, MOCK_ENTRY_2] })

    const { container } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.sr-row-label')).toBeTruthy()
    })

    // A row is the kit's CollectionRow — no longer a ghost Button, and no
    // longer a hand-rolled div either.
    const rows = Array.from(container.querySelectorAll('.ui-collection-row'))
    expect(rows.length).toBe(2)

    // Row 1: label, store, usage
    const row1Labels = rows[0].querySelectorAll('.sr-row-label')
    expect(row1Labels[0].textContent).toBe('SSH password for deploy')

    const row1Store = rows[0].querySelector('.sr-row-store')
    expect(row1Store?.textContent).toBe('System keychain')

    const row1Usage = rows[0].querySelector('.sr-row-usage')
    expect(row1Usage?.textContent).toBe('12 connections')

    // Row 2: usage 0
    const row2Labels = rows[1].querySelectorAll('.sr-row-label')
    expect(row2Labels[0].textContent).toBe('SSH password for shady@vm-dsm01:22')

    const row2Usage = rows[1].querySelector('.sr-row-usage')
    expect(row2Usage?.textContent).toBe('0 connections')
  })

  it('shows "store unreachable" when entry is not reachable', async () => {
    const { client, inventory } = mockClient()
    client.status = vi.fn().mockResolvedValue(UNSEALED_STATUS)
    const unreachable: InventoryEntry = {
      ...MOCK_ENTRY_1,
      reachable: false,
    }
    inventory.mockResolvedValue({ entries: [unreachable] })

    const { container } = await mount(client)

    // A status is a Badge, not a bespoke red span the surface drew itself.
    await vi.waitFor(() => {
      expect(container.querySelector('.ui-badge')).toBeTruthy()
    })

    const badge = container.querySelector('.ui-badge')
    expect(badge?.textContent).toBe('Store unreachable')
    expect(badge?.getAttribute('data-tone')).toBe('danger')
  })

  it('no secret value appears in rendered output and no copy/reveal controls exist', async () => {
    const { client, inventory } = mockClient()
    client.status = vi.fn().mockResolvedValue(UNSEALED_STATUS)
    inventory.mockResolvedValue({ entries: [MOCK_ENTRY_1] })

    const { container } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.sr-row-label')).toBeTruthy()
    })

    // No copy or reveal buttons
    expect(container.querySelector('[aria-label*="copy" i]')).toBeNull()
    expect(container.querySelector('[aria-label*="reveal" i]')).toBeNull()
    expect(container.querySelector('[aria-label*="show" i]')).toBeNull()

    // No <input type="password"> or similar
    expect(container.querySelector('input[type="password"]')).toBeNull()

    // The label is NOT a secret value — it's metadata
    const rowLabels = container.querySelectorAll('.sr-row-label')
    expect(rowLabels.length).toBeGreaterThanOrEqual(1)
    // Label is the derived description, NOT the secret
    expect(rowLabels[0].textContent).not.toMatch(/^\*{6,}$/)
    expect(rowLabels[0].textContent).not.toMatch(/^sec:v1:/)
  })

  // The promise "never shown back to you" answers a question you only have
  // once you are looking at a list of secrets and wondering whether you can
  // read one — so it belongs to that section, not to the top of the page.
  it('explains the list where the list is, not above every state', async () => {
    const { client, inventory } = mockClient()
    client.status = vi.fn().mockResolvedValue(UNSEALED_STATUS)
    inventory.mockResolvedValue({ entries: [MOCK_ENTRY_1] })

    const { container } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.sr-row-label')).toBeTruthy()
    })

    const description = container.querySelector('.ui-page-section__desc')
    expect(description?.textContent).toMatch(/passwords and key passphrases/)
    expect(description?.textContent).toMatch(/never shown back to you/)
  })

  // The blank page. `uninitialized` was reachable only by resetting the vault,
  // which until now could not be done from the interface — so no test named
  // the state, the nested Shows let it fall through every branch, and the
  // whole panel rendered empty. Found by resetting and clicking Secrets.
  it('offers to set protection up when there is no vault yet', async () => {
    const { client } = mockClient()
    client.status = vi.fn().mockResolvedValue({
      ...UNSEALED_STATUS,
      state: 'uninitialized' as const,
    })

    const { container, ctrl } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.ui-empty-state__title')?.textContent).toBe(
        'Protection is not set up yet',
      )
    })
    // And the remedy is offered here, not merely named: a page that announces
    // a problem offers its way out.
    const action = container.querySelector('.ui-empty-state__action button') as HTMLButtonElement
    expect(action.textContent).toBe('Set up protection')
    const openSetup = vi.spyOn(ctrl, 'openSetup')
    action.click()
    expect(openSetup).toHaveBeenCalled()
  })

  it('says so when the inventory could not be loaded, instead of showing nothing', async () => {
    const { client, inventory } = mockClient()
    client.status = vi.fn().mockResolvedValue(UNSEALED_STATUS)
    inventory.mockRejectedValue(new Error('backend went away'))

    const { container } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.ui-empty-state__title')?.textContent).toBe(
        'Could not load secrets',
      )
    })
    expect(container.querySelector('.ui-empty-state__desc')?.textContent).toContain(
      'backend went away',
    )
  })

  // The guard against the whole class. Whatever the vault says, this page
  // shows the user something — a blank panel is never an answer, and it is the
  // failure that no per-state test can rule out on its own.
  it('never renders an empty panel, in any vault state', async () => {
    for (const state of ['uninitialized', 'sealed', 'unsealed'] as const) {
      cleanup()
      const { client, inventory } = mockClient()
      client.status = vi.fn().mockResolvedValue({ ...UNSEALED_STATUS, state })
      inventory.mockResolvedValue({ entries: [] })

      const { container } = await mount(client)

      await vi.waitFor(() => {
        expect(container.textContent?.trim(), `state ${state} rendered nothing`).not.toBe('')
      })
    }
  })

  // ADR-0016: the vault owns the name. A row renders the vault's name for the
  // secret — the backend resolves the fallbacks, so the page renders verbatim
  // and never a blank.
  it('renders the vault-owned name, not a derived label', async () => {
    const { client, inventory } = mockClient()
    client.status = vi.fn().mockResolvedValue(UNSEALED_STATUS)
    inventory.mockResolvedValue({
      entries: [{ ...MOCK_ENTRY_1, name: 'prod password', ownerId: '' }],
    })

    const { container } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.sr-row-label')?.textContent).toBe('prod password')
    })
  })

  // Add: the user was asked for the name because they set out to create a
  // secret. The control exists in the loaded state, opens the dialog, and the
  // create call carries name, kind and value to the wire.
  it('adds a secret by name and kind from the loaded state', async () => {
    const { client, inventory, createSecret } = mockClient()
    client.status = vi.fn().mockResolvedValue(UNSEALED_STATUS)
    inventory.mockResolvedValue({ entries: [MOCK_ENTRY_1] })
    createSecret.mockResolvedValue({})

    const { container } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.sr-row-label')).toBeTruthy()
    })

    const addButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add a secret'),
    )
    expect(addButton).toBeTruthy()
    addButton!.click()

    await vi.waitFor(() => {
      expect(container.querySelector('.nocx-dialog__title')?.textContent).toContain('Add secret')
    })

    // The dialog asks for the name — the user did set out to create a secret.
    const nameInput = container.querySelector('#sr-add-name') as HTMLInputElement
    expect(nameInput).toBeTruthy()
    nameInput.value = 'prod password'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const valueInput = container.querySelector('#sr-add-value') as HTMLInputElement
    valueInput.value = 'hunter2'
    valueInput.dispatchEvent(new Event('input', { bubbles: true }))

    const submit = Array.from(container.querySelectorAll('.nocx-dialog button')).find(
      (b) => b.textContent === 'Add secret',
    ) as HTMLButtonElement | undefined
    submit!.click()

    await vi.waitFor(() => {
      expect(createSecret).toHaveBeenCalledWith({
        name: 'prod password',
        kind: 'password',
        value: 'hunter2',
      })
    })
  })

  // Rename: addressed by the row handle, never by a secret reference — the
  // renderer may not name one (nocx-jb20.1).
  it('renames a secret by its row handle', async () => {
    const { client, inventory, renameSecret } = mockClient()
    client.status = vi.fn().mockResolvedValue(UNSEALED_STATUS)
    inventory.mockResolvedValue({ entries: [MOCK_ENTRY_1] })
    renameSecret.mockResolvedValue({})

    const { container } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.sr-row-label')).toBeTruthy()
    })

    const renameButton = container.querySelector('[aria-label^="Rename"]') as HTMLButtonElement
    expect(renameButton).toBeTruthy()
    renameButton.click()

    await vi.waitFor(() => {
      expect(container.querySelector('.nocx-dialog__title')?.textContent).toContain('Rename')
    })

    const nameInput = container.querySelector('#sr-rename-name') as HTMLInputElement
    nameInput.value = 'the prod password'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const submit = Array.from(container.querySelectorAll('.nocx-dialog button')).find(
      (b) => b.textContent === 'Rename',
    ) as HTMLButtonElement | undefined
    submit!.click()

    await vi.waitFor(() => {
      expect(renameSecret).toHaveBeenCalledWith({
        id: MOCK_ENTRY_1.id,
        name: 'the prod password',
      })
    })
  })

  // An unowned secret — no connection uses it — is a row like any other: that
  // is the point of ADR-0016, not a side effect.
  it('renders a secret with no connection using it', async () => {
    const { client, inventory } = mockClient()
    client.status = vi.fn().mockResolvedValue(UNSEALED_STATUS)
    inventory.mockResolvedValue({
      entries: [{ ...MOCK_ENTRY_1, ownerId: '', usedBy: 0, name: 'prod password' }],
    })

    const { container } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.sr-row-label')?.textContent).toBe('prod password')
    })
    const usage = container.querySelector('.sr-row-usage')
    expect(usage?.textContent).toBe('0 connections')
  })
})
