// Vault dialogs and controller — setup (passphrase + recovery code),
// unlock (os / passphrase / recovery), and the silent-setup path.
//
// SetupDialog appears when the user saves a password and the vault is
// uninitialized with no OS-held key. It collects a master passphrase
// (with confirmation) then shows the recovery code exactly once.
//
// UnlockDialog appears when the vault is sealed, offering the available
// means. On a machine with an OS-held key, unlocking is a single click
// with no prompt.
//
// Surfaces import createVaultState for reactive state + the two dialogs,
// calling ensureBeforeSave to intercept the password-save flow.

import { createSignal, Show, type Component, type Accessor } from 'solid-js'
import { Dialog } from './ui/dialog'
import { Button } from './ui/button'
import { Stack } from './ui/stack'
import { TextField } from './ui/text-field'
import { CodeBlock } from './ui/code-block'
import { IconButton } from './ui/icon-button'
import { CopyIcon } from './ui/icons'
import { showToast } from './ui/toast'
import type { VaultClient, VaultStatus } from './vault-client'

// ── Error mapping ───────────────────────────────────────────────────────
// The Dispatcher currently drops structured RPC error fields and surfaces
// only message text, but hidden/mock clients may provide `reason` directly.
// Check both: reason-code first, then message text as fallback.

const REASON_MESSAGES: Record<string, string> = {
  'no-service': 'No system keyring available. Use a passphrase to unlock.',
  locked: 'Your login keychain is locked. Unlock it and try again.',
  denied: 'Access to the system keyring was denied.',
  timeout: 'The operation timed out. Please try again.',
  'unsupported-platform': 'System keyring is not supported on this platform.',
  'unknown-provider': 'This secret reference names a provider not available in this build.',
}

function vaultErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'reason' in err) {
    const r = (err as { reason: string }).reason
    if (r && typeof r === 'string' && REASON_MESSAGES[r]) {
      return REASON_MESSAGES[r]
    }
  }
  if (err instanceof Error) return err.message
  return 'Operation failed'
}

// ── Vault controller (reactive state + methods for surfaces) ────────────

export interface VaultController {
  /** Latest vault status from the backend, or null before the first fetch. */
  status: Accessor<VaultStatus | null>
  /** True when the setup dialog should be shown. */
  showSetup: Accessor<boolean>
  /** True when the unlock dialog should be shown. */
  showUnlock: Accessor<boolean>
  refresh(): Promise<boolean>
  /**
   * Called before saving a password. When the vault is uninitialized:
   * - osKeyAvailable → silent setup (no dialog), then continue
   * - !osKeyAvailable → show SetupDialog, continue after completion
   * When sealed → show UnlockDialog, continue after unseal
   * When unsealed → continue immediately
   */
  ensureBeforeSave(doSave: () => Promise<void>): void
  /** Call when the setup dialog completes so the deferred save can run. */
  onSetupDone(): void
  /** Call when the unlock dialog completes so the deferred save can run. */
  onUnsealDone(): void
  /** Show the unlock dialog (e.g. after a sealed-on-connect error). */
  openUnlock(): void
  closeSetup(): void
  closeUnlock(): void
}

/** Create the vault reactive state for a surface. */
export function createVaultState(vaultClient: VaultClient): VaultController {
  const [status, setStatus] = createSignal<VaultStatus | null>(null)
  const [showSetup, setShowSetup] = createSignal(false)
  const [showUnlock, setShowUnlock] = createSignal(false)

  // Pending save callback — set when we defer a save to show a dialog
  let pendingSave: (() => Promise<void>) | null = null

  async function refresh(): Promise<boolean> {
    try {
      const s = await vaultClient.status()
      setStatus(s)
      return true
    } catch {
      return false
    }
  }

  function ensureBeforeSave(doSave: () => Promise<void>): void {
    const s = status()
    if (!s) {
      // Status not yet loaded — fetch first, then re-evaluate.
      // refresh returns false on failure so we avoid re-entry.
      void refresh().then((ok) => {
        if (ok) {
          ensureBeforeSave(doSave)
        } else {
          showToast({
            level: 'danger',
            message: 'Could not check vault status. Password was not saved.',
          })
        }
      })
      return
    }

    if (s.state === 'unsealed') {
      void doSave()
      return
    }

    if (s.state === 'uninitialized') {
      if (s.osKeyAvailable) {
        // Silent setup — no dialog, then save.
        // If setup fails, show a toast so the user knows the password
        // was not stored, and do NOT call doSave.
        void vaultClient
          .setup({})
          .then(() => doSave())
          .catch((e: unknown) => {
            showToast({
              level: 'danger',
              message: vaultErrorMessage(e),
            })
          })
        return
      }
      // Show setup dialog, save after completion
      pendingSave = () => doSave()
      setShowSetup(true)
      return
    }

    // sealed
    pendingSave = () => doSave()
    setShowUnlock(true)
  }

  function onSetupDone(): void {
    const save = pendingSave
    pendingSave = null
    void save?.()
  }

  function onUnsealDone(): void {
    const save = pendingSave
    pendingSave = null
    void refresh()
    void save?.()
  }

  function openUnlock(): void {
    pendingSave = null
    setShowUnlock(true)
  }

  function closeSetup(): void {
    pendingSave = null
    setShowSetup(false)
  }

  function closeUnlock(): void {
    pendingSave = null
    setShowUnlock(false)
  }

  return {
    status,
    showSetup,
    showUnlock,
    refresh,
    ensureBeforeSave,
    onSetupDone,
    onUnsealDone,
    openUnlock,
    closeSetup,
    closeUnlock,
  }
}

// ── Setup dialog ─────────────────────────────────────────────────────────

export interface SetupDialogProps {
  open: boolean
  onClose: () => void
  /** Called after setup completes and the user has dismissed the recovery code. */
  onSetupComplete?: () => void
  vaultClient: VaultClient
}

export const SetupDialog: Component<SetupDialogProps> = (props) => {
  const [passphrase, setPassphrase] = createSignal('')
  const [confirm, setConfirm] = createSignal('')
  const [error, setError] = createSignal('')
  const [saving, setSaving] = createSignal(false)
  const [recoveryCode, setRecoveryCode] = createSignal('')
  const [copied, setCopied] = createSignal(false)

  const reset = () => {
    setPassphrase('')
    setConfirm('')
    setError('')
    setSaving(false)
    setRecoveryCode('')
    setCopied(false)
  }

  const handleSetup = async () => {
    const p = passphrase()
    const c = confirm()
    if (!p) {
      setError('Enter a master passphrase')
      return
    }
    if (p !== c) {
      setError('Passphrases do not match')
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await props.vaultClient.setup({ passphrase: p })
      if (result.recoveryCode) {
        setRecoveryCode(result.recoveryCode)
      } else {
        // Silent setup (unlikely at this point, but handle it)
        props.onSetupComplete?.()
        props.onClose()
      }
    } catch (e: unknown) {
      setError(vaultErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCode())
      setCopied(true)
      setTimeout(() => setCopied(false), 3000)
    } catch {
      // clipboard write may fail; copy silently
    }
  }

  const handleDownload = () => {
    const blob = new Blob([recoveryCode()], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nocx-vault-recovery-code.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Step 1: passphrase entry
  const passphraseView = (
    <Stack>
      <TextField
        id="vault-setup-passphrase"
        label="Master passphrase"
        type="password"
        value={passphrase()}
        onInput={(v) => {
          setPassphrase(v)
          setError('')
        }}
        error={error()}
        autoFocus
      />
      <TextField
        id="vault-setup-confirm"
        label="Confirm passphrase"
        type="password"
        value={confirm()}
        onInput={(v) => {
          setConfirm(v)
          setError('')
        }}
        error={confirm() && passphrase() !== confirm() ? 'Passphrases do not match' : undefined}
      />
    </Stack>
  )

  // Step 2: recovery code (shown exactly once)
  const recoveryView = (
    <Stack>
      <p>Your vault is ready. Save this recovery code somewhere safe — it is shown only once.</p>
      <div class="ui-vault-code-block-wrap">
        <CodeBlock>{recoveryCode()}</CodeBlock>
      </div>
      <div class="ui-vault-action-row">
        <IconButton
          ariaLabel={copied() ? 'Copied' : 'Copy recovery code'}
          onClick={() => {
            void handleCopy()
          }}
          size="sm"
        >
          <CopyIcon />
        </IconButton>
        <Button variant="ghost" onClick={handleDownload}>
          Download
        </Button>
      </div>
    </Stack>
  )

  const hasRecoveryCode = () => recoveryCode().length > 0

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        reset()
        props.onClose()
      }}
      title={hasRecoveryCode() ? 'Recovery Code' : 'Set Up Vault'}
      onSubmit={
        hasRecoveryCode()
          ? undefined
          : () => {
              void handleSetup()
            }
      }
      footer={
        hasRecoveryCode() ? (
          <Button
            variant="primary"
            onClick={() => {
              reset()
              props.onSetupComplete?.()
              props.onClose()
            }}
          >
            Done
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              disabled={saving()}
              onClick={() => {
                void handleSetup()
              }}
            >
              {saving() ? 'Setting up…' : 'Set Up'}
            </Button>
            <Button variant="default" disabled={saving()} onClick={props.onClose}>
              Cancel
            </Button>
          </>
        )
      }
    >
      <Show when={hasRecoveryCode()} fallback={passphraseView}>
        {recoveryView}
      </Show>
    </Dialog>
  )
}

// ── Unlock dialog ────────────────────────────────────────────────────────

export type UnlockMeans = 'os' | 'passphrase' | 'recovery'

export interface UnlockDialogProps {
  open: boolean
  onClose: () => void
  /** Called after the vault is unsealed. */
  onUnsealed?: () => void
  vaultClient: VaultClient
  vaultStatus: VaultStatus | null
}

export const UnlockDialog: Component<UnlockDialogProps> = (props) => {
  const [means, setMeans] = createSignal<UnlockMeans | undefined>(undefined)
  const currentMeans = () => means() ?? (props.vaultStatus?.osKeyAvailable ? 'os' : 'passphrase')
  const [secret, setSecret] = createSignal('')
  const [error, setError] = createSignal('')
  const [unlocking, setUnlocking] = createSignal(false)

  const reset = () => {
    setSecret('')
    setError('')
    setUnlocking(false)
  }

  const handleUnseal = async (overrideMeans?: UnlockMeans) => {
    const m = overrideMeans ?? currentMeans()
    if (m !== 'os' && !secret()) {
      const lbl = m === 'passphrase' ? 'passphrase' : 'recovery code'
      setError(`Enter your ${lbl}`)
      return
    }
    setError('')
    setUnlocking(true)
    try {
      await props.vaultClient.unseal(m === 'os' ? { means: m } : { means: m, secret: secret() })
      reset()
      props.onUnsealed?.()
      props.onClose()
    } catch (e: unknown) {
      setUnlocking(false)
      setError(vaultErrorMessage(e))
    }
  }

  const meansRow = (
    <div class="ui-vault-means-row">
      <Show when={props.vaultStatus?.osKeyAvailable}>
        <Button
          variant={currentMeans() === 'os' ? 'primary' : 'default'}
          onClick={() => setMeans('os')}
        >
          System key
        </Button>
      </Show>
      <Button
        variant={currentMeans() === 'passphrase' ? 'primary' : 'default'}
        onClick={() => setMeans('passphrase')}
      >
        Passphrase
      </Button>
      <Button
        variant={currentMeans() === 'recovery' ? 'primary' : 'default'}
        onClick={() => setMeans('recovery')}
      >
        Recovery code
      </Button>
    </div>
  )

  const meansForm = () => {
    const m = currentMeans()
    if (m === 'os') {
      return (
        <p class="ui-vault-desc-text">Unlock with your system keychain — no passphrase needed.</p>
      )
    }
    const label = m === 'passphrase' ? 'Passphrase' : 'Recovery code'
    const inputId = m === 'passphrase' ? 'vault-unlock-passphrase' : 'vault-unlock-recovery'
    return (
      <Stack>
        <TextField
          id={inputId}
          label={label}
          type="password"
          value={secret()}
          onInput={(v) => {
            setSecret(v)
            setError('')
          }}
          error={error()}
          autoFocus
        />
      </Stack>
    )
  }

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        reset()
        props.onClose()
      }}
      title="Unlock Vault"
      footer={
        <>
          <Button
            variant="primary"
            disabled={unlocking()}
            onClick={() => {
              void handleUnseal()
            }}
          >
            {currentMeans() === 'os' ? 'Unlock' : unlocking() ? 'Unlocking…' : 'Unlock'}
          </Button>
          <Button variant="default" disabled={unlocking()} onClick={props.onClose}>
            Cancel
          </Button>
        </>
      }
    >
      {meansRow}
      {meansForm()}
    </Dialog>
  )
}
