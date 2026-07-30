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

import { createSignal, Show, For, type Component, type Accessor } from 'solid-js'
import { Dialog } from './ui/dialog'
import { Button } from './ui/button'
import { Stack } from './ui/stack'
import { TextField } from './ui/text-field'
import { CodeBlock } from './ui/code-block'
import { IconButton } from './ui/icon-button'
import { Badge, Section, Select, Field } from './ui'
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
  if (err instanceof RpcError && err.data && typeof err.data === 'object') {
    const d = err.data as { reason?: string }
    if (d.reason && REASON_MESSAGES[d.reason]) {
      return REASON_MESSAGES[d.reason]
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
   */
  saveSecretWithVault(saveFn: () => Promise<void>): Promise<void>
  /** Seal the vault immediately. */
  seal(): Promise<void>
  /** Change the master passphrase using old passphrase or recovery code. */
  changePassphrase(params: {
    oldPassphrase?: string
    recoveryCode?: string
    newPassphrase: string
  }): Promise<void>
  /** Regenerate the recovery code. Shows once. */
  regenerateRecovery(params: { passphrase: string }): Promise<{ recoveryCode: string }>
  /** Set the default writable provider. */
  setDefaultProvider(params: { provider: string }): Promise<void>
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
      if (s.osKeyCapable) {
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
   * 2. On vault-uninitialized: checks osKeyCapable (fetches fresh status).
   *    osKeyCapable → silent setup, then retry. Silent setup failure → rejects.
   *    !osKeyCapable → SetupDialog, retry on completion.
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
      if (s.osKeyCapable) {
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

  async function seal(): Promise<void> {
    await vaultClient.seal()
    await refresh()
  }

  async function changePassphrase(params: {
    oldPassphrase?: string
    recoveryCode?: string
    newPassphrase: string
  }): Promise<void> {
    await vaultClient.changePassphrase(params)
  }

  async function regenerateRecovery(params: {
    passphrase: string
  }): Promise<{ recoveryCode: string }> {
    return vaultClient.regenerateRecovery(params)
  }

  async function setDefaultProvider(params: { provider: string }): Promise<void> {
    await vaultClient.setDefaultProvider(params)
    await refresh()
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
    seal,
    changePassphrase,
    regenerateRecovery,
    setDefaultProvider,
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

// ── Change passphrase dialog ────────────────────────────────────────────

export interface ChangePassphraseDialogProps {
  open: boolean
  onClose: () => void
  vaultClient: VaultClient
}

export const ChangePassphraseDialog: Component<ChangePassphraseDialogProps> = (props) => {
  const [mode, setMode] = createSignal<'passphrase' | 'recovery'>('passphrase')
  const [oldPassphrase, setOldPassphrase] = createSignal('')
  const [recoveryCode, setRecoveryCode] = createSignal('')
  const [newPassphrase, setNewPassphrase] = createSignal('')
  const [confirmPassphrase, setConfirmPassphrase] = createSignal('')
  const [error, setError] = createSignal('')
  const [changing, setChanging] = createSignal(false)

  const reset = () => {
    setMode('passphrase')
    setOldPassphrase('')
    setRecoveryCode('')
    setNewPassphrase('')
    setConfirmPassphrase('')
    setError('')
    setChanging(false)
  }

  const handleChange = async () => {
    setError('')
    const np = newPassphrase()
    if (!np) {
      setError('Enter a new passphrase')
      return
    }
    if (np !== confirmPassphrase()) {
      setError('Passphrases do not match')
      return
    }

    const m = mode()
    if (m === 'passphrase' && !oldPassphrase()) {
      setError('Enter your current passphrase')
      return
    }
    if (m === 'recovery' && !recoveryCode()) {
      setError('Enter your recovery code')
      return
    }

    setChanging(true)
    try {
      await props.vaultClient.changePassphrase(
        m === 'passphrase'
          ? { oldPassphrase: oldPassphrase(), newPassphrase: np }
          : { recoveryCode: recoveryCode(), newPassphrase: np },
      )
      reset()
      props.onClose()
      showToast({ level: 'success', message: 'Passphrase changed.' })
    } catch (e: unknown) {
      setChanging(false)
      setError(vaultErrorMessage(e))
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        reset()
        props.onClose()
      }}
      title="Change vault passphrase"
      onSubmit={() => {
        void handleChange()
      }}
      footer={
        <>
          <Button
            variant="primary"
            disabled={changing()}
            onClick={() => {
              void handleChange()
            }}
          >
            {changing() ? 'Changing…' : 'Change passphrase'}
          </Button>
          <Button
            variant="default"
            disabled={changing()}
            onClick={() => {
              reset()
              props.onClose()
            }}
          >
            Cancel
          </Button>
        </>
      }
    >
      <Stack>
        <div class="ui-vault-means-row">
          <Button
            variant={mode() === 'passphrase' ? 'primary' : 'default'}
            onClick={() => {
              setMode('passphrase')
              setError('')
            }}
          >
            I know my passphrase
          </Button>
          <Button
            variant={mode() === 'recovery' ? 'primary' : 'default'}
            onClick={() => {
              setMode('recovery')
              setError('')
            }}
          >
            I have a recovery code
          </Button>
        </div>

        <Show when={mode() === 'passphrase'}>
          <TextField
            id="vault-change-old-passphrase"
            label="Current passphrase"
            type="password"
            value={oldPassphrase()}
            onInput={(v) => {
              setOldPassphrase(v)
              setError('')
            }}
            autoFocus
          />
        </Show>
        <Show when={mode() === 'recovery'}>
          <TextField
            id="vault-change-recovery"
            label="Recovery code"
            type="password"
            value={recoveryCode()}
            onInput={(v) => {
              setRecoveryCode(v)
              setError('')
            }}
            autoFocus
          />
        </Show>

        <TextField
          id="vault-change-new-passphrase"
          label="New passphrase"
          type="password"
          value={newPassphrase()}
          onInput={(v) => {
            setNewPassphrase(v)
            setError('')
          }}
        />
        <TextField
          id="vault-change-confirm-passphrase"
          label="Confirm new passphrase"
          type="password"
          value={confirmPassphrase()}
          onInput={(v) => {
            setConfirmPassphrase(v)
            setError('')
          }}
          error={error()}
        />

        <p class="ui-vault-desc-text">
          Changing the passphrase requires your current passphrase or a recovery code. An OS-held
          key alone is not sufficient — a factor that only unlocks must not be able to replace the
          factor that recovers.
        </p>
      </Stack>
    </Dialog>
  )
}

// ── Recovery code dialog ────────────────────────────────────────────────

export interface RecoveryCodeDialogProps {
  open: boolean
  onClose: () => void
  vaultClient: VaultClient
}

export const RecoveryCodeDialog: Component<RecoveryCodeDialogProps> = (props) => {
  const [passphrase, setPassphrase] = createSignal('')
  const [recoveryCode, setRecoveryCode] = createSignal<string | null>(null)
  const [error, setError] = createSignal('')
  const [generating, setGenerating] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  const reset = () => {
    setPassphrase('')
    setRecoveryCode(null)
    setError('')
    setGenerating(false)
    setCopied(false)
  }

  const handleGenerate = async () => {
    if (!passphrase()) {
      setError('Enter your passphrase')
      return
    }
    setError('')
    setGenerating(true)
    try {
      const result = await props.vaultClient.regenerateRecovery({ passphrase: passphrase() })
      setRecoveryCode(result.recoveryCode)
    } catch (e: unknown) {
      setGenerating(false)
      setError(vaultErrorMessage(e))
    }
  }

  const handleCopy = () => {
    const code = recoveryCode()
    if (!code) return
    void navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true)
      },
      () => {
        /* clipboard not available */
      },
    )
  }

  const handleDone = () => {
    reset()
    props.onClose()
  }

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        reset()
        props.onClose()
      }}
      title="Reissue recovery code"
    >
      <Show when={recoveryCode() === null}>
        <Stack>
          <TextField
            id="vault-reissue-passphrase"
            label="Current passphrase"
            type="password"
            value={passphrase()}
            onInput={(v) => {
              setPassphrase(v)
              setError('')
            }}
            error={error()}
            autoFocus
          />
          <Button
            variant="primary"
            disabled={generating()}
            onClick={() => {
              void handleGenerate()
            }}
          >
            {generating() ? 'Generating…' : 'Generate new recovery code'}
          </Button>
          <Button
            variant="default"
            disabled={generating()}
            onClick={() => {
              reset()
              props.onClose()
            }}
          >
            Cancel
          </Button>
        </Stack>
      </Show>
      <Show when={recoveryCode() !== null}>
        <Stack>
          <p class="ui-vault-desc-text">
            Your new recovery code is shown below. Copy it now — it will not be displayed again.
            Keep it in a safe place.
          </p>
          <div class="ui-vault-recovery-row">
            <CodeBlock>{recoveryCode() ?? ''}</CodeBlock>
            <IconButton ariaLabel={copied() ? 'Copied' : 'Copy recovery code'} onClick={handleCopy}>
              <CopyIcon />
            </IconButton>
          </div>
          <Button variant="primary" onClick={handleDone}>
            Done
          </Button>
        </Stack>
      </Show>
    </Dialog>
  )
}

// ── Vault settings section ─────────────────────────────────────────────

export interface VaultSectionProps {
  vaultClient: VaultClient
  vaultController: VaultController
}

export function VaultSection(props: VaultSectionProps) {
  const [dialog, setDialog] = createSignal<'passphrase' | 'recovery' | null>(null)
  const [sealing, setSealing] = createSignal(false)

  const handleSeal = async () => {
    setSealing(true)
    try {
      await props.vaultController.seal()
      showToast({ level: 'success', message: 'Vault sealed.' })
    } catch (e: unknown) {
      showToast({ level: 'danger', message: vaultErrorMessage(e) })
    } finally {
      setSealing(false)
    }
  }

  const status = () => props.vaultController.status()

  const stateBadge = () => {
    const s = status()
    if (!s) return { label: 'Unknown', tone: 'neutral' as const }
    switch (s.state) {
      case 'unsealed':
        return { label: 'Unsealed', tone: 'info' as const }
      case 'sealed':
        return { label: 'Sealed', tone: 'warning' as const }
      case 'uninitialized':
        return { label: 'Uninitialized', tone: 'neutral' as const }
    }
  }

  const handleDefaultProvider = async (provider: string) => {
    try {
      await props.vaultController.setDefaultProvider({ provider })
      showToast({ level: 'success', message: 'Default provider updated.' })
    } catch (e: unknown) {
      showToast({ level: 'danger', message: vaultErrorMessage(e) })
    }
  }

  return (
    <div>
      <Section title="Status">
        <Stack>
          <Field for="vault-state" label="State" orientation="horizontal">
            <Badge tone={stateBadge().tone}>{stateBadge().label}</Badge>
          </Field>
          <Field for="vault-oskey" label="OS-held key" orientation="horizontal">
            <Show
              when={status()?.osKeyAvailable}
              fallback={<Badge tone="neutral">Not available</Badge>}
            >
              <Badge tone="info">Available</Badge>
            </Show>
          </Field>
          <Show when={status() && status()!.providers.some((p) => p.writable)}>
            <Field for="vault-default-provider" label="Default provider" orientation="horizontal">
              <Select
                value={status()!.defaultProvider ?? ''}
                onChange={(v) => {
                  void handleDefaultProvider(v)
                }}
                options={status()!
                  .providers.filter((p) => p.writable)
                  .map((p) => ({ value: p.id, label: p.id }))}
                placeholder="— None —"
                placeholderValue=""
              />
            </Field>
          </Show>
        </Stack>
      </Section>

      <Section title="Actions">
        <Stack>
          <Field for="vault-action-seal" label="Seal now" orientation="horizontal">
            <Button
              variant="default"
              disabled={sealing() || status()?.state !== 'unsealed'}
              onClick={() => {
                void handleSeal()
              }}
            >
              {sealing() ? 'Sealing…' : 'Seal now'}
            </Button>
          </Field>
          <Field for="vault-action-passphrase" label="Change passphrase" orientation="horizontal">
            <Button variant="default" onClick={() => setDialog('passphrase')}>
              Change passphrase
            </Button>
          </Field>
          <Field for="vault-action-recovery" label="Recovery code" orientation="horizontal">
            <Button variant="default" onClick={() => setDialog('recovery')}>
              Reissue recovery code
            </Button>
          </Field>
        </Stack>
      </Section>

      <Show when={status() && status()!.providers.length > 0}>
        <Section title="Providers">
          <Stack>
            <For each={status()!.providers}>
              {(p) => (
                <Field for={'vault-provider-' + p.id} label={p.id} orientation="horizontal">
                  <Stack>
                    <div>
                      <Show when={p.writable} fallback={<Badge tone="neutral">Read-only</Badge>}>
                        <Badge tone="info">Writable</Badge>
                      </Show>{' '}
                      <Show when={p.ready} fallback={<Badge tone="warning">Not ready</Badge>}>
                        <Badge tone="info">Ready</Badge>
                      </Show>
                    </div>
                    <Show when={!p.ready && p.reason}>
                      <p class="ui-vault-desc-text">
                        {REASON_MESSAGES[p.reason ?? ''] ?? p.reason}
                      </p>
                    </Show>
                  </Stack>
                </Field>
              )}
            </For>
          </Stack>
        </Section>
      </Show>

      <ChangePassphraseDialog
        open={dialog() === 'passphrase'}
        onClose={() => setDialog(null)}
        vaultClient={props.vaultClient}
      />
      <RecoveryCodeDialog
        open={dialog() === 'recovery'}
        onClose={() => setDialog(null)}
        vaultClient={props.vaultClient}
      />
    </div>
  )
}
