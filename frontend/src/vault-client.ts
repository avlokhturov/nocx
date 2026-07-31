// Vault RPC client — typed methods for the vault.* control-plane methods.
// Sibling of ProfileClient over the same Dispatcher.

import type { Dispatcher } from './dispatcher'

// The wire types are GENERATED from `contracts/vault.status.schema.json`
// (`npm run contracts`). They are re-exported here so callers keep importing
// them from the client, and so this module stays the one place that says what
// vault.* speaks.
//
// They used to be hand-written, and that is precisely how `defaultProvider`
// came to be declared here, read on every render, and never sent: a
// hand-written type can want a field the wire does not carry. A generated one
// cannot. Do not re-declare these — change the schema.
export type { VaultStatus, ProviderStatus } from './generated/vault.status'
import type { VaultStatus } from './generated/vault.status'

/** The vault's lifecycle state, as the schema's enum spells it. */
export type VaultState = VaultStatus['state']

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

export interface VaultInventoryEntry {
  kind: 'password' | 'key-passphrase'
  /** Already human-readable, derived by the backend. Render verbatim. */
  label: string
  /** Provider id: 'system' for OS keychain, 'file' for encrypted nocx storage. */
  provider: 'system' | 'file'
  /** Credential id that owns this secret, for navigation. */
  ownerId: string
  /** Number of connections that reference the owning credential. */
  usedBy: number
  /** Whether the provider that holds this secret is reachable right now. */
  reachable: boolean
}

export interface VaultInventory {
  entries: VaultInventoryEntry[]
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

  setAutoSeal(minutes: number): Promise<Record<string, never>> {
    return this.dispatcher.call('vault.setAutoSeal', { minutes })
  }

  inventory(): Promise<VaultInventory> {
    return this.dispatcher.call('vault.inventory', {})
  }

  activity(): Promise<Record<string, never>> {
    return this.dispatcher.call('vault.activity', {})
  }
}
