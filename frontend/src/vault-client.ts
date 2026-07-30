// Vault RPC client — typed methods for the vault.* control-plane methods.
// Sibling of ProfileClient over the same Dispatcher.

import type { Dispatcher } from './dispatcher'

export type VaultState = 'uninitialized' | 'sealed' | 'unsealed'

export interface ProviderStatus {
  id: string
  writable: boolean
  ready: boolean
  reason?: string
}

export interface VaultStatus {
  state: VaultState
  /**
   * STATE: this vault holds an OS-held key, so it can be unsealed by one.
   * False until setup has stored one. Ask this before offering "unlock with
   * the OS key".
   */
  osKeyAvailable: boolean
  /**
   * CAPABILITY: this machine has a system keyring that is ready and writable,
   * so setup can mint an OS-held key with no passphrase. Ask this before
   * deciding whether setup must prompt.
   *
   * The two are one word apart and mean different things, which is how
   * nocx-25k9.8 happened: the silent-setup branch read the state, which is
   * false on every uninitialized vault by construction, so it never ran and
   * the OS keychain was unreachable. If you are about to use one of these,
   * decide first whether you are asking about the machine or about the vault.
   */
  osKeyCapable: boolean
  providers: ProviderStatus[]
  defaultProvider: string | null
}

export interface VaultSetupParams {
  passphrase?: string
}

export interface VaultSetupResult {
  recoveryCode?: string
}

export interface VaultChangePassphraseParams {
  oldPassphrase?: string
  recoveryCode?: string
  newPassphrase: string
}

export interface VaultRegenerateRecoveryParams {
  passphrase: string
}

export interface VaultRegenerateRecoveryResult {
  recoveryCode: string
}

export interface VaultSetDefaultProviderParams {
  provider: string
}

export interface VaultUnsealParams {
  means: 'os' | 'passphrase' | 'recovery'
  secret?: string
}

export class VaultClient {
  constructor(private dispatcher: Dispatcher) {}

  status(): Promise<VaultStatus> {
    return this.dispatcher.call('vault.status', {})
  }

  setup(params: VaultSetupParams): Promise<VaultSetupResult> {
    return this.dispatcher.call('vault.setup', params)
  }

  unseal(params: VaultUnsealParams): Promise<Record<string, never>> {
    return this.dispatcher.call('vault.unseal', params)
  }

  seal(): Promise<Record<string, never>> {
    return this.dispatcher.call('vault.seal', {})
  }

  changePassphrase(params: VaultChangePassphraseParams): Promise<Record<string, never>> {
    return this.dispatcher.call('vault.changePassphrase', params)
  }

  regenerateRecovery(
    params: VaultRegenerateRecoveryParams,
  ): Promise<VaultRegenerateRecoveryResult> {
    return this.dispatcher.call('vault.regenerateRecovery', params)
  }

  setDefaultProvider(params: VaultSetDefaultProviderParams): Promise<Record<string, never>> {
    return this.dispatcher.call('vault.setDefaultProvider', params)
  }
}
