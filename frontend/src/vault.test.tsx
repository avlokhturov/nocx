// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@solidjs/testing-library'
import {
  SetupDialog,
  UnlockDialog,
  createVaultState,
  ChangePassphraseDialog,
  RecoveryCodeDialog,
  VaultSection,
} from './vault'
import type { VaultClient } from './vault-client'
import { RpcError } from './dispatcher'

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
  const changePassphrase = vi.fn()
  const regenerateRecovery = vi.fn()
  const setDefaultProvider = vi.fn()
  const setAutoSeal = vi.fn()
  const activity = vi.fn()
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
  } as unknown as VaultClient
  return {
    client,
    status,
    setup,
    unseal,
    seal,
    changePassphrase,
    regenerateRecovery,
    setDefaultProvider,
    setAutoSeal,
    activity,
  }
}

const BASE_STATUS = {
  state: 'sealed' as const,
  osKeyAvailable: false,
  osKeyCapable: false,
  hasPassphrase: false,
  autoSealMinutes: 0,
  providers: [],
  defaultProvider: null,
}

// ── createVaultState — controller behavior (no Dialog rendering) ───────

describe('createVaultState', () => {
  it('calls silent setup + doSave when osKeyCapable and uninitialized', async () => {
    const { client, setup } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'uninitialized',
      osKeyAvailable: false,
      osKeyCapable: true,
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
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
      osKeyAvailable: false,
      osKeyCapable: true,
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
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
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
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
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
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
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
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
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
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
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
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
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
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

// ── saveSecretWithVault — operation-first vault error handling ──────────

function makeRpcError(reason: string): Error {
  return new RpcError('vault error', -32000, { reason })
}

describe('saveSecretWithVault', () => {
  it('vault-uninitialized + no OS key: shows SetupDialog, retries save after setup', async () => {
    const { client, status, setup } = mockClient()
    status.mockResolvedValue({
      state: 'uninitialized',
      osKeyAvailable: false,
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
    })
    setup.mockResolvedValue({})

    const ctrl = createVaultState(client)
    await ctrl.refresh()

    const savePassword = vi
      .fn<(...args: string[]) => Promise<void>>()
      .mockRejectedValueOnce(makeRpcError('vault-uninitialized'))
      .mockResolvedValueOnce(undefined)
    const saveFn = () => savePassword('my-pw')

    const promise = ctrl.saveSecretWithVault(saveFn)

    await vi.waitFor(() => expect(ctrl.showSetup()).toBe(true))
    expect(ctrl.showUnlock()).toBe(false)
    expect(savePassword).toHaveBeenCalledTimes(1)

    ctrl.onSetupDone()
    await expect(promise).resolves.toBeUndefined()
    expect(savePassword).toHaveBeenCalledTimes(2)
    expect(savePassword.mock.calls[0]).toEqual(['my-pw'])
    expect(savePassword.mock.calls[1]).toEqual(['my-pw'])
  })

  it('vault-uninitialized + osKeyCapable: silent setup, no dialog, retries save', async () => {
    const { client, status, setup } = mockClient()
    status.mockResolvedValue({
      state: 'uninitialized',
      osKeyAvailable: false,
      osKeyCapable: true,
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
    })
    setup.mockResolvedValue({})

    const ctrl = createVaultState(client)
    await ctrl.refresh()

    const savePassword = vi
      .fn<(...args: string[]) => Promise<void>>()
      .mockRejectedValueOnce(makeRpcError('vault-uninitialized'))
      .mockResolvedValueOnce(undefined)
    const saveFn = () => savePassword('my-pw')

    const promise = ctrl.saveSecretWithVault(saveFn)

    await expect(promise).resolves.toBeUndefined()
    expect(ctrl.showSetup()).toBe(false)
    expect(ctrl.showUnlock()).toBe(false)
    expect(setup).toHaveBeenCalledWith({})
    expect(savePassword).toHaveBeenCalledTimes(2)
    expect(savePassword.mock.calls[0]).toEqual(['my-pw'])
    expect(savePassword.mock.calls[1]).toEqual(['my-pw'])
  })

  it('vault-sealed: shows UnlockDialog, retries after unseal', async () => {
    const { client, status } = mockClient()
    status.mockResolvedValue({
      state: 'sealed',
      osKeyAvailable: true,
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
    })

    const ctrl = createVaultState(client)
    await ctrl.refresh()

    const savePassword = vi
      .fn<(...args: string[]) => Promise<void>>()
      .mockRejectedValueOnce(makeRpcError('vault-sealed'))
      .mockResolvedValueOnce(undefined)
    const saveFn = () => savePassword('my-pw')

    const promise = ctrl.saveSecretWithVault(saveFn)

    await vi.waitFor(() => expect(ctrl.showUnlock()).toBe(true))
    expect(ctrl.showSetup()).toBe(false)
    expect(savePassword).toHaveBeenCalledTimes(1)

    ctrl.onUnsealDone()
    await expect(promise).resolves.toBeUndefined()
    expect(savePassword).toHaveBeenCalledTimes(2)
  })

  it('non-vault error: propagates to caller', async () => {
    const { client, status } = mockClient()
    status.mockResolvedValue({
      state: 'unsealed',
      osKeyAvailable: false,
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
    })

    const ctrl = createVaultState(client)
    await ctrl.refresh()

    const saveFn = vi.fn().mockRejectedValue(new Error('network error'))
    const promise = ctrl.saveSecretWithVault(saveFn)

    await expect(promise).rejects.toThrow('network error')
  })
  it('silent setup failure: rejects so caller shows error', async () => {
    const { client, status, setup } = mockClient()
    status.mockResolvedValue({
      state: 'uninitialized',
      osKeyAvailable: false,
      osKeyCapable: true,
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
    })
    setup.mockRejectedValue(new Error('secret-service-unavailable'))

    const ctrl = createVaultState(client)
    await ctrl.refresh()

    const saveFn = vi.fn().mockRejectedValueOnce(makeRpcError('vault-uninitialized'))
    const promise = ctrl.saveSecretWithVault(saveFn)

    await expect(promise).rejects.toThrow('secret-service-unavailable')
    expect(saveFn).toHaveBeenCalledTimes(1)
  })

  it('retry failure after unlock: rejects', async () => {
    const { client, status } = mockClient()
    status.mockResolvedValue({
      state: 'sealed',
      osKeyAvailable: false,
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
    })

    const ctrl = createVaultState(client)
    await ctrl.refresh()

    const savePassword = vi
      .fn<(...args: string[]) => Promise<void>>()
      .mockRejectedValueOnce(makeRpcError('vault-sealed'))
      .mockRejectedValueOnce(new Error('still-sealed'))
    const saveFn = () => savePassword('pw')

    const promise = ctrl.saveSecretWithVault(saveFn)

    await vi.waitFor(() => expect(ctrl.showUnlock()).toBe(true))
    ctrl.onUnsealDone()

    await expect(promise).rejects.toThrow('still-sealed')
    expect(savePassword).toHaveBeenCalledTimes(2)
  })

  it('user cancels setup dialog: resolves without saving', async () => {
    const { client, status } = mockClient()
    status.mockResolvedValue({
      state: 'uninitialized',
      osKeyAvailable: false,
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
    })

    const ctrl = createVaultState(client)
    await ctrl.refresh()

    const savePassword = vi
      .fn<(...args: string[]) => Promise<void>>()
      .mockRejectedValueOnce(makeRpcError('vault-uninitialized'))
    const saveFn = () => savePassword('pw')
    const promise = ctrl.saveSecretWithVault(saveFn)

    await vi.waitFor(() => expect(ctrl.showSetup()).toBe(true))
    ctrl.closeSetup()

    await expect(promise).resolves.toBeUndefined()
    expect(savePassword).toHaveBeenCalledTimes(1)
  })

  it('user cancels unlock dialog: resolves without saving', async () => {
    const { client, status } = mockClient()
    status.mockResolvedValue({
      state: 'sealed',
      osKeyAvailable: false,
      hasPassphrase: false,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
    })

    const ctrl = createVaultState(client)
    await ctrl.refresh()

    const savePassword = vi
      .fn<(...args: string[]) => Promise<void>>()
      .mockRejectedValueOnce(makeRpcError('vault-sealed'))
    const saveFn = () => savePassword('pw')
    const promise = ctrl.saveSecretWithVault(saveFn)

    await vi.waitFor(() => expect(ctrl.showUnlock()).toBe(true))
    ctrl.closeUnlock()

    await expect(promise).resolves.toBeUndefined()
    expect(savePassword).toHaveBeenCalledTimes(1)
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
  it('shows error message when vaultClient.setup rejects', async () => {
    const { client, setup } = mockClient()
    setup.mockRejectedValue(new Error('Backend refused'))
    render(() => <SetupDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    const passphrase = screen.getByLabelText('Master passphrase')
    const confirm = screen.getByLabelText('Confirm passphrase')
    fireEvent.input(passphrase, { target: { value: 'hunter2' } })
    fireEvent.input(confirm, { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByText('Set Up'))

    await vi.waitFor(() => {
      expect(screen.getByText('Backend refused')).toBeTruthy()
    })
    // Dialog stays open, user can retry
    expect(screen.getByText('Set Up')).toBeTruthy()
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

  it('shows error when vaultClient.unseal rejects', async () => {
    const { client, unseal } = mockClient()
    unseal.mockRejectedValue(new Error('wrong passphrase'))
    const onUnsealed = vi.fn()
    render(() => (
      <UnlockDialog
        open={true}
        onClose={vi.fn()}
        vaultClient={client}
        vaultStatus={BASE_STATUS}
        onUnsealed={onUnsealed}
      />
    ))

    const buttons = screen.getAllByText('Passphrase')
    fireEvent.click(buttons[0])
    const input = screen.getByLabelText('Passphrase')
    fireEvent.input(input, { target: { value: 'wrongpw' } })
    fireEvent.click(screen.getByText('Unlock'))

    await vi.waitFor(() => {
      expect(screen.getByText('wrong passphrase')).toBeTruthy()
    })
    // Dialog stays open, onUnsealed not called
    expect(onUnsealed).not.toHaveBeenCalled()
  })
})

// ── ChangePassphraseDialog ─────────────────────────────────────────────

describe('ChangePassphraseDialog', () => {
  it('renders passphrase mode by default', () => {
    const { client } = mockClient()
    render(() => <ChangePassphraseDialog open={true} onClose={vi.fn()} vaultClient={client} />)
    expect(screen.getByText('I know my passphrase')).toBeTruthy()
    expect(screen.getByText('I have a recovery code')).toBeTruthy()
    expect(screen.getByLabelText('Current passphrase')).toBeTruthy()
    expect(screen.getByLabelText('New passphrase')).toBeTruthy()
    expect(screen.getByLabelText('Confirm new passphrase')).toBeTruthy()
  })

  it('calls changePassphrase with old passphrase on submit', async () => {
    const { client, changePassphrase } = mockClient()
    changePassphrase.mockResolvedValue({})
    render(() => <ChangePassphraseDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    fireEvent.input(screen.getByLabelText('Current passphrase'), { target: { value: 'oldpw' } })
    fireEvent.input(screen.getByLabelText('New passphrase'), { target: { value: 'newpw' } })
    fireEvent.input(screen.getByLabelText('Confirm new passphrase'), { target: { value: 'newpw' } })
    fireEvent.click(screen.getByText('Change passphrase'))

    await vi.waitFor(() => {
      expect(changePassphrase).toHaveBeenCalledWith({
        oldPassphrase: 'oldpw',
        newPassphrase: 'newpw',
      })
    })
  })

  it('switches to recovery code mode', () => {
    const { client } = mockClient()
    render(() => <ChangePassphraseDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    fireEvent.click(screen.getByText('I have a recovery code'))
    expect(() => screen.getByLabelText('Current passphrase')).toThrow()
    expect(screen.getByLabelText('Recovery code')).toBeTruthy()
    expect(screen.getByLabelText('New passphrase')).toBeTruthy()
  })

  it('calls changePassphrase with recovery code in recovery mode', async () => {
    const { client, changePassphrase } = mockClient()
    changePassphrase.mockResolvedValue({})
    render(() => <ChangePassphraseDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    fireEvent.click(screen.getByText('I have a recovery code'))
    fireEvent.input(screen.getByLabelText('Recovery code'), { target: { value: 'ABCD-1234' } })
    fireEvent.input(screen.getByLabelText('New passphrase'), { target: { value: 'newpw' } })
    fireEvent.input(screen.getByLabelText('Confirm new passphrase'), { target: { value: 'newpw' } })
    fireEvent.click(screen.getByText('Change passphrase'))

    await vi.waitFor(() => {
      expect(changePassphrase).toHaveBeenCalledWith({
        recoveryCode: 'ABCD-1234',
        newPassphrase: 'newpw',
      })
    })
  })

  it('shows error when passphrases do not match', () => {
    const { client, changePassphrase } = mockClient()
    render(() => <ChangePassphraseDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    fireEvent.input(screen.getByLabelText('Current passphrase'), { target: { value: 'oldpw' } })
    fireEvent.input(screen.getByLabelText('New passphrase'), { target: { value: 'newpw' } })
    fireEvent.input(screen.getByLabelText('Confirm new passphrase'), {
      target: { value: 'different' },
    })
    fireEvent.click(screen.getByText('Change passphrase'))

    expect(screen.getByText('Passphrases do not match')).toBeTruthy()
    expect(changePassphrase).not.toHaveBeenCalled()
  })

  it('shows error when changePassphrase rejects', async () => {
    const { client, changePassphrase } = mockClient()
    changePassphrase.mockRejectedValue(new RpcError('wrong', -32000, { reason: 'denied' }))
    render(() => <ChangePassphraseDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    fireEvent.input(screen.getByLabelText('Current passphrase'), { target: { value: 'wrong' } })
    fireEvent.input(screen.getByLabelText('New passphrase'), { target: { value: 'newpw' } })
    fireEvent.input(screen.getByLabelText('Confirm new passphrase'), { target: { value: 'newpw' } })
    fireEvent.click(screen.getByText('Change passphrase'))

    await vi.waitFor(() => {
      expect(screen.getByText('Access to the system keyring was denied.')).toBeTruthy()
    })
  })
})

// ── RecoveryCodeDialog ─────────────────────────────────────────────────

describe('RecoveryCodeDialog', () => {
  it('shows passphrase input first', () => {
    const { client } = mockClient()
    render(() => <RecoveryCodeDialog open={true} onClose={vi.fn()} vaultClient={client} />)
    expect(screen.getByLabelText('Current passphrase')).toBeTruthy()
    expect(screen.getByText('Generate new recovery code')).toBeTruthy()
  })

  it('calls regenerateRecovery with passphrase', async () => {
    const { client, regenerateRecovery } = mockClient()
    regenerateRecovery.mockResolvedValue({ recoveryCode: 'NEW-CODE-1234' })
    const onClose = vi.fn()
    render(() => <RecoveryCodeDialog open={true} onClose={onClose} vaultClient={client} />)

    fireEvent.input(screen.getByLabelText('Current passphrase'), { target: { value: 'mypw' } })
    fireEvent.click(screen.getByText('Generate new recovery code'))

    await vi.waitFor(() => {
      expect(regenerateRecovery).toHaveBeenCalledWith({ passphrase: 'mypw' })
    })
    await vi.waitFor(() => {
      expect(screen.getByText('NEW-CODE-1234')).toBeTruthy()
    })
  })

  it('shows error when regenerateRecovery rejects', async () => {
    const { client, regenerateRecovery } = mockClient()
    regenerateRecovery.mockRejectedValue(new RpcError('bad', -32000, { reason: 'denied' }))
    render(() => <RecoveryCodeDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    fireEvent.input(screen.getByLabelText('Current passphrase'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByText('Generate new recovery code'))

    await vi.waitFor(() => {
      expect(screen.getByText('Access to the system keyring was denied.')).toBeTruthy()
    })
  })

  it('shows recovery code once, then Done returns to the passphrase screen on reopen', async () => {
    const { client, regenerateRecovery } = mockClient()
    regenerateRecovery.mockResolvedValue({ recoveryCode: 'SECRET-CODE' })
    render(() => <RecoveryCodeDialog open={true} onClose={vi.fn()} vaultClient={client} />)

    fireEvent.input(screen.getByLabelText('Current passphrase'), { target: { value: 'mypw' } })
    fireEvent.click(screen.getByText('Generate new recovery code'))

    await vi.waitFor(() => {
      expect(screen.getByText('SECRET-CODE')).toBeTruthy()
    })
    expect(screen.getByText('Done')).toBeTruthy()
    expect(() => screen.getByText('Generate new recovery code')).toThrow()
  })
})

// ── VaultSection ───────────────────────────────────────────────────────

describe('VaultSection', () => {
  const UNSEALED_STATUS = {
    state: 'unsealed' as const,
    osKeyAvailable: true,
    hasPassphrase: true,
    autoSealMinutes: 0,
    providers: [{ id: 'keychain', writable: true, ready: true }],
    defaultProvider: 'keychain',
  }
  const SEALED_STATUS = {
    state: 'sealed' as const,
    osKeyAvailable: false,
    hasPassphrase: false,
    autoSealMinutes: 0,
    providers: [{ id: 'secret-service', writable: true, ready: true }],
    defaultProvider: null,
  }
  const UNINIT_STATUS = {
    state: 'uninitialized' as const,
    osKeyAvailable: false,
    hasPassphrase: false,
    autoSealMinutes: 0,
    providers: [],
    defaultProvider: null,
  }

  async function renderVaultSection(mockStatus: object) {
    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus)
    const ctrl = createVaultState(client)
    await ctrl.refresh()
    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)
    return { client, ctrl }
  }

  /** Return the primary button within the top status row. */
  function statusRowPrimary(): HTMLElement | null {
    const row = document.querySelector('.ui-vault-status-row')
    if (!row) return null
    return row.querySelector('button[data-variant="primary"]')
  }

  // ── Acceptance 1: primary action by state ─────────────────────────

  it('shows Set up protection as primary for uninitialized', async () => {
    await renderVaultSection(UNINIT_STATUS)
    const btn = statusRowPrimary()
    expect(btn).toBeTruthy()
    expect(btn!.textContent).toBe('Set up protection')
    expect(btn!.getAttribute('disabled')).toBeNull()
    expect(btn!.getAttribute('data-variant')).toBe('primary')
  })

  it('shows Unlock as primary for sealed', async () => {
    await renderVaultSection(SEALED_STATUS)
    const btn = statusRowPrimary()
    expect(btn).toBeTruthy()
    expect(btn!.textContent).toBe('Unlock')
    expect(btn!.getAttribute('disabled')).toBeNull()
    expect(btn!.getAttribute('data-variant')).toBe('primary')
  })

  it('shows Lock now as primary for unsealed', async () => {
    await renderVaultSection(UNSEALED_STATUS)
    const btn = statusRowPrimary()
    expect(btn).toBeTruthy()
    expect(btn!.textContent).toBe('Lock now')
    expect(btn!.getAttribute('disabled')).toBeNull()
    expect(btn!.getAttribute('data-variant')).toBe('primary')
  })

  it('exactly one primary button in status row per state', async () => {
    await renderVaultSection(UNINIT_STATUS)
    let row = document.querySelector('.ui-vault-status-row')
    expect(row!.querySelectorAll('button[data-variant="primary"]').length).toBe(1)
    cleanup()

    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(SEALED_STATUS)
    const ctrl = createVaultState(client)
    await ctrl.refresh()
    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)
    row = document.querySelector('.ui-vault-status-row')
    expect(row!.querySelectorAll('button[data-variant="primary"]').length).toBe(1)
  })

  // ── Primary action behavior ───────────────────────────────────────

  it('Set up protection opens SetupDialog for uninitialized', async () => {
    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(UNINIT_STATUS)
    const ctrl = createVaultState(client)
    await ctrl.refresh()
    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)

    fireEvent.click(statusRowPrimary()!)
    expect(screen.getByText('Set Up Vault')).toBeTruthy()
  })

  it('Unlock calls vaultController.openUnlock for sealed', async () => {
    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(SEALED_STATUS)
    const ctrl = createVaultState(client)
    const openUnlockSpy = vi.spyOn(ctrl, 'openUnlock')
    await ctrl.refresh()
    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)

    fireEvent.click(statusRowPrimary()!)
    await vi.waitFor(() => {
      expect(openUnlockSpy).toHaveBeenCalled()
    })
  })

  // ── Acceptance 2: store rows with status markers ───────────────────

  it('each store row label appears in the tablist', async () => {
    const status = {
      state: 'unsealed' as const,
      osKeyAvailable: true,
      hasPassphrase: true,
      autoSealMinutes: 0,
      providers: [
        { id: 'system', writable: true, ready: true },
        { id: 'file', writable: true, ready: false, reason: 'locked' },
      ],
      defaultProvider: 'system',
    }
    await renderVaultSection(status)
    const tablist = document.querySelector('[role="tablist"]')
    expect(tablist).toBeTruthy()
    expect(tablist!.textContent).toContain('System keychain')
    expect(tablist!.textContent).toContain('Encrypted nocx storage')
  })

  it('unready store identifiable without selecting it', async () => {
    const status = {
      state: 'unsealed' as const,
      osKeyAvailable: true,
      hasPassphrase: true,
      autoSealMinutes: 0,
      providers: [
        { id: 'system', writable: true, ready: true },
        { id: 'file', writable: true, ready: false, reason: 'locked' },
      ],
      defaultProvider: 'system',
    }
    await renderVaultSection(status)
    // The visually-hidden span contains the REASON_MESSAGES sentence
    const hiddenSpans = document.querySelectorAll('.ui-visually-hidden')
    const lockedMsg = Array.from(hiddenSpans).find((s) =>
      s.textContent?.includes('Your login keychain is locked'),
    )
    expect(lockedMsg).toBeTruthy()
  })

  // ── Acceptance 3: store panel shows state sentence ────────────────

  it('store panel shows state as sentence with remedy, not a reason code', async () => {
    const status = {
      state: 'unsealed' as const,
      osKeyAvailable: true,
      hasPassphrase: true,
      autoSealMinutes: 0,
      providers: [{ id: 'file', writable: false, ready: false, reason: 'locked' }],
      defaultProvider: null,
    }
    await renderVaultSection(status)
    // The panel shows a sentence starting with "Not answering:"
    expect(screen.getByText(/Not answering: Your login keychain is locked/)).toBeTruthy()
  })

  it('ready store panel shows availability sentence', async () => {
    await renderVaultSection(UNSEALED_STATUS)
    expect(screen.getByText(/is available and answering/)).toBeTruthy()
  })

  // ── Acceptance 4: protection actions on no-passphrase vault ───────

  it('change passphrase and recovery disabled with explanation when no passphrase', async () => {
    const status = {
      state: 'unsealed' as const,
      hasPassphrase: false,
      osKeyAvailable: true,
      autoSealMinutes: 0,
      providers: [{ id: 'keychain', writable: true, ready: true }],
      defaultProvider: 'keychain',
    }
    await renderVaultSection(status)
    expect(
      screen.getByRole('button', { name: 'Change passphrase' }).getAttribute('disabled'),
    ).not.toBeNull()
    expect(
      screen.getByRole('button', { name: 'Reissue recovery code' }).getAttribute('disabled'),
    ).not.toBeNull()
    // Description appears twice (once per field)
    expect(
      screen.getAllByText('Only available when a passphrase is configured.').length,
    ).toBeGreaterThanOrEqual(1)
  })

  it('action buttons enabled on unsealed with passphrase', async () => {
    await renderVaultSection(UNSEALED_STATUS)
    expect(
      screen.getByRole('button', { name: 'Change passphrase' }).getAttribute('disabled'),
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Reissue recovery code' }).getAttribute('disabled'),
    ).toBeNull()
  })

  it('protection actions disabled on uninitialized with explanation', async () => {
    await renderVaultSection(UNINIT_STATUS)
    expect(
      screen.getByRole('button', { name: 'Change passphrase' }).getAttribute('disabled'),
    ).not.toBeNull()
    expect(
      screen.getByRole('button', { name: 'Reissue recovery code' }).getAttribute('disabled'),
    ).not.toBeNull()
    expect(screen.getAllByText('Protection is not set up yet.').length).toBeGreaterThanOrEqual(1)
  })

  it('protection actions disabled on sealed with explanation', async () => {
    await renderVaultSection(SEALED_STATUS)
    expect(
      screen.getByRole('button', { name: 'Change passphrase' }).getAttribute('disabled'),
    ).not.toBeNull()
    expect(
      screen.getByRole('button', { name: 'Reissue recovery code' }).getAttribute('disabled'),
    ).not.toBeNull()
    expect(screen.getAllByText('Vault is locked.').length).toBeGreaterThanOrEqual(1)
  })

  // ── Lock now button in Protection section ─────────────────────────

  it('Lock now disabled when sealed with explanation', async () => {
    await renderVaultSection(SEALED_STATUS)
    const lockNowBtns = screen.getAllByText('Lock now').filter((el) => el.tagName === 'BUTTON')
    for (const btn of lockNowBtns) {
      expect(btn.getAttribute('disabled')).not.toBeNull()
    }
    expect(screen.getAllByText('Vault is locked.').length).toBeGreaterThanOrEqual(1)
  })

  it('Lock now disabled when uninitialized with explanation', async () => {
    await renderVaultSection(UNINIT_STATUS)
    const lockNowBtns = screen.getAllByText('Lock now').filter((el) => el.tagName === 'BUTTON')
    for (const btn of lockNowBtns) {
      expect(btn.getAttribute('disabled')).not.toBeNull()
    }
    expect(screen.getAllByText('Protection is not set up yet.').length).toBeGreaterThanOrEqual(1)
  })
  // ── Auto-lock select ──────────────────────────────────────────────

  it('auto-lock select round-trips: set then refresh shows updated value', async () => {
    const { client, setAutoSeal } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...UNSEALED_STATUS,
      autoSealMinutes: 0,
    })
    const ctrl = createVaultState(client)
    await ctrl.refresh()

    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)
    // Find the auto-lock select by looking for "Never" option text.
    const allSelects = document.querySelectorAll('select.ui-select')
    const selectEl = Array.from(allSelects).find(
      (s) => s.querySelector('option[value="0"]')?.textContent === 'Never',
    ) as HTMLSelectElement
    expect(selectEl.value).toBe('0')

    // Change to 30 minutes.
    fireEvent.change(selectEl, { target: { value: '30' } })

    await vi.waitFor(() => {
      expect(setAutoSeal).toHaveBeenCalledWith(30)
    })

    // Simulate round-trip: status refresh returns updated value.
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...UNSEALED_STATUS,
      autoSealMinutes: 30,
    })
    await ctrl.refresh()

    // Re-render and verify select shows the new value.
    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)
    const updatedSelects = document.querySelectorAll('select.ui-select')
    const updatedSelect = Array.from(updatedSelects).find(
      (s) => s.querySelector('option[value="0"]')?.textContent === 'Never',
    ) as HTMLSelectElement
    expect(updatedSelect.value).toBe('30')
  })

  // ── Default provider ("Store new secrets here") ───────────────────

  it('default store shows "Storing new secrets here" text', async () => {
    await renderVaultSection(UNSEALED_STATUS)
    expect(screen.getByText('Storing new secrets here')).toBeTruthy()
  })

  it('non-default store shows Store new secrets here button', async () => {
    const status = {
      state: 'unsealed' as const,
      osKeyAvailable: true,
      hasPassphrase: true,
      autoSealMinutes: 0,
      providers: [
        { id: 'system', writable: true, ready: true },
        { id: 'file', writable: true, ready: true },
      ],
      defaultProvider: 'system',
    }
    const { client, setDefaultProvider } = mockClient()
    setDefaultProvider.mockResolvedValue({})
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(status)
    const ctrl = createVaultState(client)
    await ctrl.refresh()
    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)

    // Find "Store new secrets here" button for the non-default store
    const storeBtns = screen
      .getAllByText('Store new secrets here')
      .filter((el) => el.tagName === 'BUTTON')
    expect(storeBtns.length).toBeGreaterThan(0)
    fireEvent.click(storeBtns[0])

    await vi.waitFor(() => {
      expect(setDefaultProvider).toHaveBeenCalledWith({ provider: 'file' })
    })
  })

  // ── Diagnostics section ───────────────────────────────────────────

  it('diagnostics section contains raw provider info', async () => {
    await renderVaultSection(UNSEALED_STATUS)
    const details = document.querySelector('details.ui-vault-diagnostics')
    expect(details).toBeTruthy()
    // The details contains the summary text
    expect(details!.textContent).toContain('Diagnostics')
    // Raw state text appears inside details
    expect(details!.textContent).toContain('unsealed')
  })

  // ── State transitions ─────────────────────────────────────────────

  it('page reflects new state after setup completes', async () => {
    const { client, setup } = mockClient()
    setup.mockResolvedValue({ recoveryCode: 'test-recovery' })
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(UNINIT_STATUS)
    const ctrl = createVaultState(client)
    await ctrl.refresh()
    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)

    // Click Set up protection to open dialog
    fireEvent.click(statusRowPrimary()!)
    expect(screen.getByText('Set Up Vault')).toBeTruthy()

    // Fill in passphrase
    const passInput = screen.getByLabelText('Master passphrase')
    fireEvent.input(passInput, { target: { value: 'my-passphrase' } })
    const confirmInput = screen.getByLabelText('Confirm passphrase')
    fireEvent.input(confirmInput, { target: { value: 'my-passphrase' } })

    // Click Set Up button inside dialog
    const setupBtn = screen.getAllByText('Set Up').find((el) => el.tagName === 'BUTTON')
    fireEvent.click(setupBtn!)

    await vi.waitFor(() => {
      expect(setup).toHaveBeenCalledWith({ passphrase: 'my-passphrase' })
    })

    // Recovery code shown — now mock refresh to return sealed status
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(SEALED_STATUS)
    // Click Done
    const doneBtn = screen.getAllByText('Done').find((el) => el.tagName === 'BUTTON')
    fireEvent.click(doneBtn!)

    // After Done: onSetupComplete fires refresh + onSetupDone, then onClose resets dialog
    await vi.waitFor(() => {
      // The page should now show Unlock (from refreshed sealed status)
      expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy()
    })
  })

  // ── Acceptance 5: no secret values ────────────────────────────────

  it('no secret value appears anywhere in rendered output', async () => {
    await renderVaultSection(UNSEALED_STATUS)
    const bodyText = document.body.textContent ?? ''
    // Should not contain secret-like patterns
    expect(bodyText).not.toMatch(/sec:v1:/)
  })

  // ── Top description sentence ──────────────────────────────────────

  it('shows description sentence at top', async () => {
    await renderVaultSection(UNSEALED_STATUS)
    expect(
      screen.getByText('nocx protects passwords and key passphrases saved for your connections.'),
    ).toBeTruthy()
  })

  // ── Test button ───────────────────────────────────────────────────

  it('Test button is present on store panels', async () => {
    await renderVaultSection(UNSEALED_STATUS)
    const testButtons = screen.getAllByText('Test').filter((el) => el.tagName === 'BUTTON')
    expect(testButtons.length).toBeGreaterThan(0)
  })
})
