// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import { SecretsSection } from './secrets'
import { createVaultState } from './vault'
import type { VaultClient, VaultInventory, VaultInventoryEntry } from './vault-client'

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
  } as unknown as VaultClient
  return { client, inventory, status }
}

const SEALED_STATUS = {
  state: 'sealed' as const,
  osKeyAvailable: false,
  osKeyCapable: false,
  hasPassphrase: false,
  autoSealMinutes: 0,
  providers: [],
  defaultProvider: null,
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

const MOCK_ENTRY_1: VaultInventoryEntry = {
  kind: 'password',
  label: 'SSH password for deploy',
  provider: 'system',
  ownerId: 'cred:prod-deploy',
  usedBy: 12,
  reachable: true,
}

const MOCK_ENTRY_2: VaultInventoryEntry = {
  kind: 'password',
  label: 'SSH password for shady@vm-dsm01:22',
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
    // The permanent description IS always visible
    expect(container.textContent).toMatch(/passwords and key passphrases/)
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

    // A row is a div.sr-row — no longer a ghost Button.
    const rows = Array.from(container.querySelectorAll('.sr-row'))
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
    const unreachable: VaultInventoryEntry = {
      ...MOCK_ENTRY_1,
      reachable: false,
    }
    inventory.mockResolvedValue({ entries: [unreachable] })

    const { container } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.sr-row-unreachable')).toBeTruthy()
    })

    const unreachableEl = container.querySelector('.sr-row-unreachable')
    expect(unreachableEl?.textContent).toBe('Store unreachable')
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

  it('permanently shows the explanation text', async () => {
    const { client, inventory } = mockClient()
    client.status = vi.fn().mockResolvedValue(UNSEALED_STATUS)
    inventory.mockResolvedValue({ entries: [MOCK_ENTRY_1] })

    const { container } = await mount(client)

    await vi.waitFor(() => {
      expect(container.querySelector('.sr-row-label')).toBeTruthy()
    })

    const description = container.querySelector('.sr-description')
    expect(description?.textContent).toMatch(/passwords and key passphrases/)
  })
})
