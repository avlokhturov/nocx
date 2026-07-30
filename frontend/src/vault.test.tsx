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
  const client = {
    status,
    setup,
    unseal,
    seal,
    changePassphrase,
    regenerateRecovery,
    setDefaultProvider,
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
  }
}

const BASE_STATUS = {
  state: 'sealed' as const,
  osKeyAvailable: false,
  providers: [],
  defaultProvider: null,
}

// ── createVaultState — controller behavior (no Dialog rendering) ───────

describe('createVaultState', () => {
  it('calls silent setup + doSave when osKeyAvailable and uninitialized', async () => {
    const { client, setup } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'uninitialized',
      osKeyAvailable: true,
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
      osKeyAvailable: true,
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

  it('vault-uninitialized + osKeyAvailable: silent setup, no dialog, retries save', async () => {
    const { client, status, setup } = mockClient()
    status.mockResolvedValue({
      state: 'uninitialized',
      osKeyAvailable: true,
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
      osKeyAvailable: true,
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
    providers: [{ id: 'keychain', writable: true, ready: true }],
    defaultProvider: 'keychain',
  }
  const SEALED_STATUS = {
    state: 'sealed' as const,
    osKeyAvailable: false,
    providers: [{ id: 'secret-service', writable: true, ready: true }],
    defaultProvider: null,
  }
  const UNINIT_STATUS = {
    state: 'uninitialized' as const,
    osKeyAvailable: false,
    providers: [],
    defaultProvider: null,
  }

  async function renderVaultSection(mockStatus: object) {
    const { client, seal } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus)
    const ctrl = createVaultState(client)
    await ctrl.refresh()
    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)
    return { client, ctrl, seal }
  }

  it('shows state badge for unsealed', async () => {
    await renderVaultSection(UNSEALED_STATUS)
    expect(screen.getByText('Unsealed')).toBeTruthy()
  })

  it('shows state badge for sealed', async () => {
    await renderVaultSection(SEALED_STATUS)
    expect(screen.getByText('Sealed')).toBeTruthy()
  })

  it('shows state badge for uninitialized', async () => {
    await renderVaultSection(UNINIT_STATUS)
    expect(screen.getByText('Uninitialized')).toBeTruthy()
  })

  it('shows OS-held key availability', async () => {
    await renderVaultSection(UNSEALED_STATUS)
    expect(screen.getByText('Available')).toBeTruthy()
  })

  it('shows OS-held key not available', async () => {
    await renderVaultSection(SEALED_STATUS)
    expect(screen.getByText('Not available')).toBeTruthy()
  })

  it('seal button calls vaultController.seal', async () => {
    const { ctrl } = await renderVaultSection(UNSEALED_STATUS)
    const sealSpy = vi.spyOn(ctrl, 'seal').mockResolvedValue(undefined)

    const allSealNow = screen.getAllByText('Seal now')
    const sealBtn = allSealNow.find((el) => el.tagName === 'BUTTON')
    fireEvent.click(sealBtn!)
    await vi.waitFor(() => {
      expect(sealSpy).toHaveBeenCalled()
    })
  })

  it('seal button is disabled when sealed', async () => {
    await renderVaultSection(SEALED_STATUS)
    const allSealNow = screen.getAllByText('Seal now')
    const sealBtn = allSealNow.find((el) => el.tagName === 'BUTTON')
    expect(sealBtn!.getAttribute('disabled')).not.toBeNull()
  })

  it('renders provider list with badges', async () => {
    await renderVaultSection(UNSEALED_STATUS)
    const allKeychain = screen.getAllByText('keychain')
    const providerLabel = allKeychain.find((el) => el.tagName === 'LABEL')
    expect(providerLabel).toBeTruthy()
    expect(screen.getByText('Writable')).toBeTruthy()
    expect(screen.getByText('Ready')).toBeTruthy()
  })

  it('shows provider reason when not ready', async () => {
    const status = {
      state: 'unsealed' as const,
      osKeyAvailable: true,
      providers: [{ id: 'keychain', writable: false, ready: false, reason: 'Keychain locked' }],
      defaultProvider: null,
    }
    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(status)
    const ctrl = createVaultState(client)
    await ctrl.refresh()
    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)

    expect(screen.getByText('Keychain locked')).toBeTruthy()
  })

  it('selecting default provider calls setDefaultProvider', async () => {
    const status = {
      state: 'unsealed' as const,
      osKeyAvailable: true,
      providers: [
        { id: 'keychain', writable: true, ready: true },
        { id: 'secret-service', writable: true, ready: true },
      ],
      defaultProvider: 'keychain',
    }
    const { client, setDefaultProvider } = mockClient()
    setDefaultProvider.mockResolvedValue({})
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(status)
    const ctrl = createVaultState(client)
    await ctrl.refresh()
    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)

    const select = screen.getByDisplayValue('keychain')
    fireEvent.change(select, { target: { value: 'secret-service' } })

    await vi.waitFor(() => {
      expect(setDefaultProvider).toHaveBeenCalledWith({ provider: 'secret-service' })
    })
  })

  it('refreshes status after vault.changed push', async () => {
    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(UNSEALED_STATUS)
    const ctrl = createVaultState(client)
    await ctrl.refresh()

    // Simulate vault.changed by changing status and refreshing
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(SEALED_STATUS)
    await ctrl.refresh()

    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)
    expect(screen.getByText('Sealed')).toBeTruthy()
  })

  it('shows provider not-ready reason for each unready provider', async () => {
    const status = {
      state: 'unsealed' as const,
      osKeyAvailable: true,
      providers: [
        { id: 'keychain', writable: false, ready: false, reason: 'Unlock your login keychain' },
      ],
      defaultProvider: null,
    }
    const { client } = mockClient()
    ;(client.status as ReturnType<typeof vi.fn>).mockResolvedValue(status)
    const ctrl = createVaultState(client)
    await ctrl.refresh()
    render(() => <VaultSection vaultClient={client} vaultController={ctrl} />)

    expect(screen.getByText('Unlock your login keychain')).toBeTruthy()
  })
})
