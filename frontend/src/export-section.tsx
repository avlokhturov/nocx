/**
 * Export / Backup / Import — the page, rebuilt around the two things a user
 * comes here to do: make a backup, and restore one.
 *
 * The previous page offered an inventory of file formats — a plaintext
 * configuration export, a portable encrypted export with its own passphrase
 * fields, a plaintext reveal, a same-machine "backup" that showed file paths
 * instead of making a file, and three separate import inputs (.json, .enc,
 * Tabby .yml). It grew as each capability landed, so it read as a list of
 * formats rather than as the two verbs anyone actually wants.
 *
 * Now:
 *   - Make a backup — one action, one file (.enc), the passphrase that
 *     protects it, and an honest statement of what is inside. This is the
 *     backup the epic means: made on A, restored on B.
 *   - Restore a backup — one action, one file, and what will happen to what
 *     is already here.
 *   - Import from Tabby — a real third thing and a genuine entry point for
 *     a new user, kept as its own thing rather than a third item in a list
 *     of file inputs.
 *
 * Deliberately gone: the plaintext configuration export (.json) and the
 * same-machine "backup" (a path listing, not a file — the copy step is a
 * later task's). A backup is the encrypted file: it is the only format that
 * carries settings and private content, and it is the only one the restore
 * side accepts. The transport methods behind the removed controls still
 * exist; the page no longer offers what it cannot stand behind.
 *
 * State: local createStores per section. Nothing here is shared state —
 * these are per-operation busy flags and form drafts (nocx-imkb.5).
 */

import { Show, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import { render } from 'solid-js/web'
import type { ProfileClient, ExportManifest, ImportResult } from './profiles'
import { VaultOperationCancelledError, type VaultController } from './vault'
import { downloadBinary } from './export-utils'
import { PageSection } from './ui/page-section'
import { Button } from './ui/button'
import { TextField } from './ui/text-field'
import { Checkbox } from './ui/checkbox'
import { FileInput } from './ui/file-input'
import { showConfirm } from './ui/dialog'
import { Field } from './ui/field'
import { Stack } from './ui/stack'
import { MarkerList, type MarkerListItem } from './ui/marker-list'
import { showToast } from './ui/toast'

// ── Manifest display ────────────────────────────────────────────────────

/**
 * What a mode carries, omits and warns about, as one MarkerList.
 *
 * The stances are the kit component's tones; this function only shapes the
 * data.
 */
function ManifestDisplay(props: { manifest: ExportManifest }) {
  const items = (): MarkerListItem[] => [
    ...props.manifest.carries.map((text) => ({ text, tone: 'included' as const })),
    ...props.manifest.omits.map((text) => ({ text, tone: 'excluded' as const })),
    ...(props.manifest.notes ?? []).map((text) => ({ text, tone: 'note' as const })),
  ]
  return <MarkerList items={items()} />
}

// ── Make a backup ──────────────────────────────────────────────────────

/**
 * One action: produce the encrypted backup file. The passphrase is chosen
 * here and protects the file on any machine it travels to; the plaintext
 * reveal is a decision, not a default — it exists because a mistyped
 * passphrase on this screen is permanent: the manifest itself warns the
 * backup is unrecoverable without it, so seeing what you typed is the
 * cheapest lockout prevention the page has.
 */
function MakeBackupSection(props: { profileClient: ProfileClient }) {
  const [state, setState] = createStore({
    passphrase: '',
    confirm: '',
    showPasswords: false,
    includePrivate: false,
    busy: false,
    loading: true,
    manifest: null as ExportManifest | null,
    error: null as string | null,
  })

  onMount(() => {
    props.profileClient.exportManifest('portable-encrypted').then(
      (m) => setState({ loading: false, manifest: m }),
      (e) => setState({ loading: false, error: `Failed to load: ${String(e)}` }),
    )
  })

  const handleMakeBackup = () => {
    const pass = state.passphrase
    const conf = state.confirm
    if (!pass) {
      showToast({ level: 'warning', message: 'Passphrase is required' })
      return
    }
    if (pass !== conf) {
      showToast({ level: 'warning', message: 'Passphrases do not match' })
      return
    }
    setState('busy', true)
    props.profileClient
      .portableEncryptedExport(pass, state.includePrivate)
      .then(
        (result) => {
          downloadBinary('nocx-backup.enc', result.payload)
          showToast({
            level: 'success',
            message: 'Backup downloaded — keep the passphrase safe',
          })
          setState('passphrase', '')
          setState('confirm', '')
        },
        (e) => {
          showToast({ level: 'danger', message: `Backup failed: ${String(e)}` })
        },
      )
      .finally(() => {
        setState('busy', false)
      })
  }

  const inputType = () => (state.showPasswords ? 'text' : 'password')

  return (
    <PageSection
      id="st-export-backup"
      title="Make a backup"
      description="One encrypted file containing your connections, groups, settings and — when you opt in — your command history. Made here, restored anywhere."
    >
      <Show when={state.loading}>
        <div class="st-export-loading">Loading…</div>
      </Show>
      <Show when={state.error !== null && !state.loading}>
        <div class="st-export-error">{state.error}</div>
      </Show>
      <Show when={state.manifest !== null && !state.loading}>
        <ManifestDisplay manifest={state.manifest!} />
      </Show>
      <Stack gap="default">
        <TextField
          label="Passphrase"
          type={inputType()}
          placeholder="Choose a strong passphrase"
          value={state.passphrase}
          onInput={(v) => setState('passphrase', v)}
        />
        <TextField
          label="Confirm passphrase"
          type={inputType()}
          placeholder="Re-enter the passphrase"
          value={state.confirm}
          onInput={(v) => setState('confirm', v)}
        />
        <Checkbox
          checked={state.showPasswords}
          onChange={(v) => setState('showPasswords', v)}
          label="Show passphrase"
        />
        <Checkbox
          checked={state.includePrivate}
          onChange={(v) => setState('includePrivate', v)}
          label="Include private content (conversations, command history)"
        />
        <Button variant="primary" disabled={state.busy} onClick={handleMakeBackup}>
          {state.busy ? 'Making backup…' : 'Make backup'}
        </Button>
      </Stack>
    </PageSection>
  )
}

// ── Restore a backup ───────────────────────────────────────────────────

/**
 * One action: pick the backup file, enter its passphrase, restore. The
 * statement of what happens to what is already here is the point of this
 * section — restore replaces, it does not merge.
 */
function RestoreBackupSection(props: { profileClient: ProfileClient }) {
  const [state, setState] = createStore({
    file: null as File | null,
    passphrase: '',
    busy: false,
    loading: true,
    manifest: null as ExportManifest | null,
    error: null as string | null,
  })

  onMount(() => {
    props.profileClient.exportManifest('import').then(
      (m) => setState({ loading: false, manifest: m }),
      (e) => setState({ loading: false, error: `Failed to load: ${String(e)}` }),
    )
  })

  const handleRestore = () => {
    const file = state.file
    if (!file) return
    // Captured here, in the event handler, so the promise chain below reads
    // a plain value rather than a reactive signal outside a tracked scope.
    const passphrase = state.passphrase
    const pc = props.profileClient
    setState('busy', true)
    file
      .arrayBuffer()
      .then((buf) => {
        const base64 = btoa(Array.from(new Uint8Array(buf), (b) => String.fromCharCode(b)).join(''))
        return pc.importPortable(base64, passphrase)
      })
      .then((result: ImportResult) => {
        showToast({
          level: 'success',
          message: `Restored ${result.profilesImported} profiles, ${result.groupsImported} groups`,
        })
        // The file stays picked so a repeat restore (or a re-entry of the
        // passphrase after a typo) can go again without re-selecting; the
        // passphrase is cleared so the next restore is a fresh decision.
        setState('passphrase', '')
      })
      .catch((e) => {
        showToast({ level: 'danger', message: `Restore failed: ${String(e)}` })
      })
      .finally(() => {
        setState('busy', false)
      })
  }

  return (
    <PageSection
      id="st-export-restore"
      title="Restore a backup"
      description="Everything in the backup replaces what is already here: connections and groups with the same identifiers are overwritten, settings are replaced, and command history from the backup is added to this machine's."
    >
      <Show when={state.loading}>
        <div class="st-export-loading">Loading…</div>
      </Show>
      <Show when={state.error !== null && !state.loading}>
        <div class="st-export-error">{state.error}</div>
      </Show>
      <Show when={state.manifest !== null && !state.loading}>
        <ManifestDisplay manifest={state.manifest!} />
      </Show>
      <Stack gap="default">
        <Field for="restore-backup-file" label="Backup file (.enc)">
          <FileInput id="restore-backup-file" accept=".enc" onChange={(f) => setState('file', f)} />
        </Field>
        <Field for="restore-backup-passphrase" label="Passphrase">
          <TextField
            id="restore-backup-passphrase"
            type="password"
            placeholder="Passphrase used when the backup was made"
            value={state.passphrase}
            onInput={(v) => setState('passphrase', v)}
          />
        </Field>
        <Button
          variant="primary"
          disabled={state.busy || !state.file || !state.passphrase}
          onClick={handleRestore}
        >
          {state.busy ? 'Restoring…' : 'Restore backup'}
        </Button>
      </Stack>
    </PageSection>
  )
}

// ── Import from Tabby ──────────────────────────────────────────────────

/**
 * A real third thing and a genuine entry point for a new user, kept as its
 * own thing rather than a third item in a list of file inputs. The flow is
 * preview-first: nothing is written until the user confirms the plan.
 */
function TabbyImportSection(props: {
  profileClient: ProfileClient
  vaultController?: VaultController
}) {
  const [state, setState] = createStore({
    tabbyFile: null as File | null,
    tabbyPass: '',
    tabbyBusy: false,
  })

  const handleTabbyImport = async () => {
    const file = state.tabbyFile
    if (!file) return
    const pc = props.profileClient
    setState('tabbyBusy', true)
    try {
      const text = await file.text()
      // Preview first.
      const preview = await pc.tabbyPreview(text, state.tabbyPass || undefined)

      // Build confirmation details with per-entry info.
      const parts: string[] = [
        `${preview.profilesToImport} profile(s), ${preview.groupsToImport} group(s),` +
          ` ${preview.secretsToImport} secret(s)`,
      ]
      if (preview.profileEntries && preview.profileEntries.length > 0) {
        parts.push('')
        parts.push('Profiles:')
        for (const e of preview.profileEntries) {
          const action =
            e.action === 'overwrite'
              ? ' (overwrites existing)'
              : e.action === 'needs-review'
                ? ' (needs review)'
                : ''
          parts.push(`  ${e.name}${action}`)
        }
      }
      if (preview.groupNames && preview.groupNames.length > 0) {
        parts.push('')
        parts.push('Groups: ' + preview.groupNames.join(', '))
      }
      if (preview.secretEntries && preview.secretEntries.length > 0) {
        parts.push('')
        parts.push('Secrets:')
        for (const e of preview.secretEntries) {
          parts.push(`  ${e.name} (${e.type})`)
        }
      }
      if (preview.collisions && preview.collisions.length > 0) {
        parts.push('')
        parts.push('Collisions:')
        for (const c of preview.collisions) {
          const policy =
            c.policy === 'overwrite'
              ? 'will be overwritten'
              : c.policy === 'refuse'
                ? 'import refused'
                : 'needs review'
          parts.push(`  ${c.kind} "${c.name}" — ${policy}`)
        }
      }
      if (preview.skippedSecrets && preview.skippedSecrets.length > 0) {
        parts.push('')
        parts.push('Skipped secrets:')
        for (const s of preview.skippedSecrets) {
          parts.push(`  ${s.secretType}: ${s.reason}`)
        }
      }
      parts.push('')
      parts.push(`Destination: ${preview.secretProvider}`)

      // Confirm with per-entry details via the kit's showConfirm.
      const confirmed = await showConfirm(
        parts.join('\n') + '\n\nProceed with import?',
        'Import',
        'Cancel',
      )
      if (!confirmed) {
        setState('tabbyFile', null)
        setState('tabbyBusy', false)
        return
      }

      // Execute with vault retry if vault controller is available.
      const doExecute = async (): Promise<void> => {
        const result = await pc.tabbyExecute(preview.planToken)
        setState('tabbyFile', null)
        const execSummary = `Imported ${result.profilesImported} connections, ${result.groupsImported} groups`
        showToast({ level: 'success', message: execSummary })
      }

      if (props.vaultController) {
        try {
          await props.vaultController.saveSecretWithVault(doExecute, 'import connections')
        } catch (err) {
          // The user cancelled the vault prompt: nothing ran, nothing failed.
          if (err instanceof VaultOperationCancelledError) return
          throw err
        }
      } else {
        await doExecute()
      }
    } catch (e) {
      showToast({ level: 'danger', message: `Tabby import failed: ${String(e)}` })
    } finally {
      setState('tabbyBusy', false)
    }
  }

  return (
    <PageSection
      id="st-export-tabby"
      title="Import from Tabby"
      description="Bring connections, groups and vault secrets from a Tabby config (.yml/.yaml). A preview is shown before anything is written."
    >
      <Stack gap="default">
        <Field for="tabby-config-file" label="Tabby config file">
          <FileInput
            id="tabby-config-file"
            accept=".yml,.yaml"
            onChange={(f) => setState('tabbyFile', f)}
          />
        </Field>
        <Field for="tabby-vault-passphrase" label="Vault passphrase (if encrypted)">
          <TextField
            id="tabby-vault-passphrase"
            type="password"
            placeholder="Leave blank unless the Tabby vault is encrypted"
            value={state.tabbyPass}
            onInput={(v) => setState('tabbyPass', v)}
          />
        </Field>
        <Button
          variant="primary"
          disabled={state.tabbyBusy || !state.tabbyFile}
          onClick={() => void handleTabbyImport()}
        >
          {state.tabbyBusy ? 'Preparing…' : 'Preview import'}
        </Button>
      </Stack>
    </PageSection>
  )
}

// ── Root component ─────────────────────────────────────────────────────

/**
 * The Export / Backup / Import page.
 *
 * No wrapping PageSection of its own: this is a page in the settings rail
 * now, and the rail entry already names it.
 */
export function ExportSection(props: {
  profileClient: ProfileClient
  vaultController?: VaultController
}) {
  return (
    <div class="ui-export">
      <p class="ui-export-desc">
        A backup is one encrypted file. Make it here, restore it anywhere — on this machine or
        another. Secrets are never in it; you bind them on the machine that restores.
      </p>
      <MakeBackupSection profileClient={props.profileClient} />
      <RestoreBackupSection profileClient={props.profileClient} />
      <TabbyImportSection
        profileClient={props.profileClient}
        vaultController={props.vaultController}
      />
    </div>
  )
}

// ── Island mount, for imperative callers only ───────────────────────────
// The settings surface is still imperative, so it cannot place <ExportSection/>
// as a child; it has to open a Solid root inside one of its elements. That is
// what this is — a mounting boundary, not a compatibility shim, and it goes
// when the settings surface migrates and renders the component directly.
//
// It returns the disposer deliberately. render() hands back the only way to
// tear the root down, and dropping it leaves effects alive on nodes the caller
// has already removed from the document.

export function mountExportSection(
  container: HTMLElement,
  profileClient: ProfileClient,
): () => void {
  return render(() => <ExportSection profileClient={profileClient} />, container)
}
