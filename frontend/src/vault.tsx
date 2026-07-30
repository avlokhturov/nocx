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
import { RpcError } from './dispatcher'
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
  /** Preflight-based vault check — see saveSecretWithVault for the operation-first replacement. */
  ensureBeforeSave(doSave: () => Promise<void>): void
  /** Call when the setup dialog completes so the deferred save can run. */
  onSetupDone(): void
  /** Call when the unlock dialog completes so the deferred save can run. */
  onUnsealDone(): void
  /** Show the unlock dialog (e.g. after a sealed-on-connect error). */
  openUnlock(): void
  closeSetup(): void
  closeUnlock(): void
  /**
   * Runs `saveFn` and catches vault errors with dialog + retry.
   *
   * 1. Tries saveFn first (operation-first, not preflight).
   * 2. On vault-uninitialized: silent setup (osKeyAvailable) or SetupDialog,
   *    then retries saveFn exactly once.
   * 3. On vault-sealed: UnlockDialog, then retries once.
   * 4. On any other error: rejects (propagates to caller's catch).
   * 5. If silent setup fails: shows a toast and resolves without saving.
   * 6. If user cancels a dialog: resolves without saving.
   */
  saveSecretWithVault(saveFn: () => Promise<void>): Promise<void>
}

/** Create the vault reactive state for a surface. */
export function createVaultState(vaultClient: VaultClient): VaultController {
  const [status_, setStatus] = createSignal<VaultStatus | null>(null)
  const [showSetup, setShowSetup] = createSignal(false)
  const [showUnlock, setShowUnlock] = createSignal(false)

  // Pending save callback — set when we defer a save to show a dialog
  let pendingSave: (() => Promise<void>) | null = null
  // Promise controls for saveSecretWithVault — resolve/reject the caller's promise
  // when the deferred save runs or the dialog is cancelled.
  let pendingResolve: ((value: undefined) => void) | null = null
  let pendingReject: ((reason: unknown) => void) | null = null

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
    const s = status_()
    if (!s) {
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
    pendingResolve?.(undefined)
    pendingResolve = null
    pendingReject = null
    setShowSetup(false)
  }

  function closeUnlock(): void {
    pendingSave = null
    pendingResolve?.(undefined)
    pendingResolve = null
    pendingReject = null
    setShowUnlock(false)
  }

  /**
   * saveSecretWithVault — operation-first vault error handling with retry.
   *
   * 1. Tries saveFn first. On success, resolves.
   * 2. On vault-uninitialized: checks osKeyAvailable (fetches fresh status).
   *    osKeyAvailable → silent setup, then retry. Silent setup failure → rejects.
   *    !osKeyAvailable → SetupDialog, retry on completion.
   * 3. On vault-sealed: UnlockDialog, retry on completion.
   * 4. On any other error: rejects (propagates to caller's catch).
   * 5. User cancels a dialog: resolves (no-op, caller continues without saving).
   */
  function saveSecretWithVault(saveFn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      pendingResolve = resolve
      pendingReject = reject

      const attempt = (): void => {
        void saveFn()
          .then(() => {
            pendingResolve?.(undefined)
            pendingResolve = null
            pendingReject = null
          })
          .catch((err: unknown) => {
            if (!(err instanceof RpcError)) {
              pendingReject?.(err)
              pendingResolve = null
              pendingReject = null
              return
            }
            const reason = (err.data as { reason?: string } | undefined)?.reason
            if (reason === 'vault-uninitialized') {
              void handleUninitialized(saveFn)
              return
            }
            if (reason === 'vault-sealed') {
              void handleSealed(saveFn)
              return
            }
            // Non-vault RPC error — propagate
            pendingReject?.(err)
            pendingResolve = null
            pendingReject = null
          })
      }

      attempt()
    })
  }

  /** Handle a vault-uninitialized error: silent setup or dialog, then retry once. */
  async function handleUninitialized(saveFn: () => Promise<void>): Promise<void> {
    // Fetch fresh status — the error came from the backend, cached status may be stale.
    try {
      const s = await vaultClient.status()
      setStatus(s)
      if (s.osKeyAvailable) {
        try {
          await vaultClient.setup({})
          // Retry the save once
          await saveFn()
          pendingResolve?.(undefined)
          pendingResolve = null
          pendingReject = null
          return
        } catch (e2) {
          // Silent setup failed — reject so caller never shows "Saved"
          pendingReject?.(e2)
          pendingResolve = null
          pendingReject = null
          return
        }
      }
      // No OS key — show SetupDialog, retry on completion
      pendingSave = (): Promise<void> => {
        return saveFn().then(
          () => {
            pendingResolve?.(undefined)
            pendingResolve = null
            pendingReject = null
          },
          (e3: unknown) => {
            pendingReject?.(e3)
            pendingResolve = null
            pendingReject = null
          },
        )
      }
      setShowSetup(true)
    } catch {
      // Status fetch itself failed — cannot determine remedy
      pendingReject?.(new Error('Vault status unavailable'))
      pendingResolve = null
      pendingReject = null
    }
  }

  /** Handle a vault-sealed error: show UnlockDialog, retry on completion. */
  function handleSealed(saveFn: () => Promise<void>): void {
    void refresh()
    pendingSave = (): Promise<void> => {
      return saveFn().then(
        () => {
          pendingResolve?.(undefined)
          pendingResolve = null
          pendingReject = null
        },
        (e: unknown) => {
          pendingReject?.(e)
          pendingResolve = null
          pendingReject = null
        },
      )
    }
    setShowUnlock(true)
  }

  return {
    status: status_,
    showSetup,
    showUnlock,
    refresh,
    ensureBeforeSave,
    onSetupDone,
    onUnsealDone,
    openUnlock,
    closeSetup,
    closeUnlock,
    saveSecretWithVault,
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
