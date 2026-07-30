// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@solidjs/testing-library'
import { SetupDialog, UnlockDialog, createVaultState } from './vault'
import { VaultClient } from './vault-client'

// ── jsdom patch: native <dialog> showModal/close are unsupported ──────
// jsdom 29 does not implement HTMLDialogElement.prototype.showModal.
// We stub both methods so Dialog's createEffect does not throw.
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
  const client = { status, setup, unseal, seal } as unknown as VaultClient
  return { client, status, setup, unseal, seal }
}

const BASE_STATUS = {
  state: 'sealed' as const,
  osKeyAvailable: false,
  providers: [],
}

// ── createVaultState — controller behavior (no Dialog rendering) ───────

describe('createVaultState', () => {
  it('calls silent setup + doSave when osKeyAvailable and uninitialized', async () => {
    const { client, setup } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'uninitialized',
      osKeyAvailable: true,
      providers: [],
    })
    setup.mockResolvedValue({})

    const ctrl = createVaultState(client)
    await ctrl.refresh()

    const doSave = vi.fn().mockResolvedValue(undefined)
    ctrl.ensureBeforeSave(doSave)

    // Silent setup: no dialog shown, setup called, save called
    expect(ctrl.showSetup()).toBe(false)
    await vi.waitFor(() => {
      expect(setup).toHaveBeenCalledWith({})
    })
    await vi.waitFor(() => {
      expect(doSave).toHaveBeenCalled()
    })
  })

  it('does not save when silent setup fails', async () => {
    const { client, setup } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'uninitialized',
      osKeyAvailable: true,
      providers: [],
    })
    setup.mockRejectedValue(new Error('no-service'))

    const ctrl = createVaultState(client)
    await ctrl.refresh()

    const doSave = vi.fn().mockResolvedValue(undefined)
    ctrl.ensureBeforeSave(doSave)

    await vi.waitFor(() => {
      expect(setup).toHaveBeenCalledWith({})
    })
    // doSave must NOT be called when setup fails
    expect(doSave).not.toHaveBeenCalled()
  })

  it('shows setup dialog when uninitialized and no OS key', async () => {
    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'uninitialized',
      osKeyAvailable: false,
      providers: [],
    })

    const ctrl = createVaultState(client)
    await ctrl.refresh()
    const doSave = vi.fn()

    ctrl.ensureBeforeSave(doSave)

    expect(ctrl.showSetup()).toBe(true)
    expect(ctrl.showUnlock()).toBe(false)
    expect(doSave).not.toHaveBeenCalled()
  })

  it('shows unlock dialog when sealed', async () => {
    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'sealed',
      osKeyAvailable: true,
      providers: [],
    })

    const ctrl = createVaultState(client)
    await ctrl.refresh()
    const doSave = vi.fn()

    ctrl.ensureBeforeSave(doSave)

    expect(ctrl.showUnlock()).toBe(true)
    expect(ctrl.showSetup()).toBe(false)
    expect(doSave).not.toHaveBeenCalled()
  })

  it('calls doSave immediately when already unsealed', async () => {
    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'unsealed',
      osKeyAvailable: true,
      providers: [],
    })

    const ctrl = createVaultState(client)
    await ctrl.refresh()
    const doSave = vi.fn().mockResolvedValue(undefined)

    ctrl.ensureBeforeSave(doSave)

    await vi.waitFor(() => {
      expect(doSave).toHaveBeenCalled()
    })
    expect(ctrl.showSetup()).toBe(false)
    expect(ctrl.showUnlock()).toBe(false)
  })

  it('fetches status first when status is null', async () => {
    const { client } = mockClient()
    // Status is null initially — refresh not called
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'unsealed',
      osKeyAvailable: false,
      providers: [],
    })

    const ctrl = createVaultState(client)
    // Do NOT call refresh() — status signal is null
    const doSave = vi.fn().mockResolvedValue(undefined)

    ctrl.ensureBeforeSave(doSave)

    // Should fetch status, see it's unsealed, and call doSave
    await vi.waitFor(() => {
      expect(doSave).toHaveBeenCalled()
    })
  })

  it('does not save when null status and refresh fails', async () => {
    const { client, status } = mockClient()
    // Status is null (refresh not called) and status() rejects
    status.mockRejectedValue(new Error('disconnected'))

    const ctrl = createVaultState(client)
    const doSave = vi.fn().mockResolvedValue(undefined)

    ctrl.ensureBeforeSave(doSave)

    // Refresh fails, doSave must NOT be called
    await vi.waitFor(() => {
      expect(status).toHaveBeenCalled()
    })
    expect(doSave).not.toHaveBeenCalled()
  })

  it('resumes deferred save via onSetupDone after setup dialog', async () => {
    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'uninitialized',
      osKeyAvailable: false,
      providers: [],
    })

    const ctrl = createVaultState(client)
    await ctrl.refresh()
    const doSave = vi.fn().mockResolvedValue(undefined)

    ctrl.ensureBeforeSave(doSave)
    expect(ctrl.showSetup()).toBe(true)
    expect(doSave).not.toHaveBeenCalled()

    // Surface calls this after setup dialog completes
    ctrl.onSetupDone()
    await vi.waitFor(() => {
      expect(doSave).toHaveBeenCalled()
    })
  })

  it('resumes deferred save via onUnsealDone after unlock dialog', async () => {
    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'sealed',
      osKeyAvailable: false,
      providers: [],
    })

    const ctrl = createVaultState(client)
    await ctrl.refresh()
    const doSave = vi.fn().mockResolvedValue(undefined)

    ctrl.ensureBeforeSave(doSave)
    expect(ctrl.showUnlock()).toBe(true)
    expect(doSave).not.toHaveBeenCalled()

    // Surface calls this after unlock dialog completes
    ctrl.onUnsealDone()
    await vi.waitFor(() => {
      expect(doSave).toHaveBeenCalled()
    })
  })
})

// ── SetupDialog ────────────────────────────────────────────────────────

describe('SetupDialog', () => {
  it('renders passphrase fields when open', () => {
    const { client } = mockClient()
    render(() => <SetupDialog open={true} onClose={vi.fn()} vaultClient={client} />)
    expect(screen.getByLabelText('Master passphrase')).toBeTruthy()
    expect(screen.getByLabelText('Confirm passphrase')).toBeTruthy()
    expect(screen.getByText('Set Up')).toBeTruthy()
    expect(screen.getByText('Cancel')).toBeTruthy()
  })

  it('calls vaultClient.setup when passphrases match and Set Up is clicked', async () => {
    const { client, setup } = mockClient()
    setup.mockResolvedValue({})
    render(() => <SetupDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    const passphrase = screen.getByLabelText('Master passphrase')
    const confirm = screen.getByLabelText('Confirm passphrase')
    fireEvent.input(passphrase, { target: { value: 'hunter2' } })
    fireEvent.input(confirm, { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByText('Set Up'))

    await vi.waitFor(() => {
      expect(setup).toHaveBeenCalledWith({ passphrase: 'hunter2' })
    })
  })

  it('shows error and does not call setup when passphrases do not match', () => {
    const { client, setup } = mockClient()
    render(() => <SetupDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    const passphrase = screen.getByLabelText('Master passphrase')
    const confirm = screen.getByLabelText('Confirm passphrase')
    fireEvent.input(passphrase, { target: { value: 'hunter2' } })
    fireEvent.input(confirm, { target: { value: 'wrong' } })
    fireEvent.click(screen.getByText('Set Up'))

    const errors = screen.getAllByText('Passphrases do not match')
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(setup).not.toHaveBeenCalled()
  })

  it('shows error and does not call setup when passphrase is empty', () => {
    const { client, setup } = mockClient()
    render(() => <SetupDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    fireEvent.click(screen.getByText('Set Up'))

    expect(screen.getByText('Enter a master passphrase')).toBeTruthy()
    expect(setup).not.toHaveBeenCalled()
  })

  it('shows recovery code after setup succeeds', async () => {
    const { client, setup } = mockClient()
    setup.mockResolvedValue({ recoveryCode: 'ABCD-1234-EFGH-5678' })
    render(() => <SetupDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    const passphrase = screen.getByLabelText('Master passphrase')
    const confirm = screen.getByLabelText('Confirm passphrase')
    fireEvent.input(passphrase, { target: { value: 'hunter2' } })
    fireEvent.input(confirm, { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByText('Set Up'))

    await vi.waitFor(() => {
      expect(screen.getByText('ABCD-1234-EFGH-5678')).toBeTruthy()
    })
    expect(screen.getByText('Done')).toBeTruthy()
  })
})

// ── UnlockDialog ───────────────────────────────────────────────────────

describe('UnlockDialog', () => {
  it('calls vaultClient.unseal with os means when OS key is available', async () => {
    const { client, unseal } = mockClient()
    unseal.mockResolvedValue({})
    render(() => (
      <UnlockDialog
        open={true}
        onClose={vi.fn()}
        vaultClient={client}
        vaultStatus={{ ...BASE_STATUS, osKeyAvailable: true }}
      />
    ))

    fireEvent.click(screen.getByText('Unlock'))

    await vi.waitFor(() => {
      expect(unseal).toHaveBeenCalledWith({ means: 'os' })
    })
  })

  it('calls vaultClient.unseal with passphrase when passphrase is entered', async () => {
    const { client, unseal } = mockClient()
    unseal.mockResolvedValue({})
    render(() => (
      <UnlockDialog open={true} onClose={vi.fn()} vaultClient={client} vaultStatus={BASE_STATUS} />
    ))

    const buttons = screen.getAllByText('Passphrase')
    fireEvent.click(buttons[0])
    const input = screen.getByLabelText('Passphrase')
    fireEvent.input(input, { target: { value: 'mypass' } })
    fireEvent.click(screen.getByText('Unlock'))

    await vi.waitFor(() => {
      expect(unseal).toHaveBeenCalledWith({ means: 'passphrase', secret: 'mypass' })
    })
  })

  it('calls vaultClient.unseal with recovery code when recovery mode is selected', async () => {
    const { client, unseal } = mockClient()
    unseal.mockResolvedValue({})
    render(() => (
      <UnlockDialog open={true} onClose={vi.fn()} vaultClient={client} vaultStatus={BASE_STATUS} />
    ))

    fireEvent.click(screen.getByText('Recovery code'))
    const input = screen.getByLabelText('Recovery code')
    fireEvent.input(input, { target: { value: 'ABCD-1234' } })
    fireEvent.click(screen.getByText('Unlock'))

    await vi.waitFor(() => {
      expect(unseal).toHaveBeenCalledWith({ means: 'recovery', secret: 'ABCD-1234' })
    })
  })

  it('shows error when unlocking with empty passphrase', () => {
    const { client, unseal } = mockClient()
    render(() => (
      <UnlockDialog open={true} onClose={vi.fn()} vaultClient={client} vaultStatus={BASE_STATUS} />
    ))

    const buttons = screen.getAllByText('Passphrase')
    fireEvent.click(buttons[0])
    fireEvent.click(screen.getByText('Unlock'))

    expect(screen.getByText('Enter your passphrase')).toBeTruthy()
    expect(unseal).not.toHaveBeenCalled()
  })
})
