/**
 * ConnectionsView — Solid component for the connections manager.
 *
 * Full-width connection list with dialog-based editing (wave 6).
 * Spec §5 of the connection manager design: nothing hidden, nothing asked twice.
 *
 * Pattern follows credentials.tsx: full-width list, editing in a Dialog.
 * Tabby import moved to Export / Backup / Import section.
 */
import { For, Show, createSignal, createMemo, createEffect, on, onMount, type JSX } from 'solid-js'
import { Button } from './ui/button'
import { TextField } from './ui/text-field'
import { Checkbox } from './ui/checkbox'
import { Select, type SelectOption } from './ui/select'
import { Dialog, showConfirm } from './ui/dialog'
import { Radio } from './ui/radio'
import { Section } from './ui/section'
import { Stack } from './ui/stack'
import { Tabs } from './ui/tabs'
import { EmptyState } from './ui/empty-state'
import { Field } from './ui/field'
import { FileInput } from './ui/file-input'
import { SegmentedControl } from './ui/segmented-control'
import { Badge } from './ui/badge'
import { IconButton } from './ui/icon-button'
import { CollectionRow, CollectionView } from './ui/collection-view'
import { CheckCircleIcon, PencilIcon, PlugIcon, TrashIcon } from './ui/icons'
import {
  createFormValidation,
  required,
  hostname,
  port as portRule,
  nonNegativeInteger,
  combine,
} from './ui/validation'
import type {
  SSHProfile,
  ProfileGroup,
  Credential,
  AuthMode,
  TreeNode,
  EffectiveProfileDTO,
  EffectiveFieldDTO,
  FieldSourceDTO,
  SessionStatus,
  ProbeOutcome,
  GroupImpactResponse,
  ConfigExport,
  SSHConfigPathResult,
  TabbyPreviewResponse,
} from './profiles'
import { ProfileClient, buildGroupTree, parseQuickConnect } from './profiles'
import { RpcError } from './dispatcher'
import { CredentialForm, type CredentialFormHandle } from './credential-form'
import { PasswordEditor } from './password-editor'
import { AuthenticationEditor } from './authentication-editor'
import { log } from './log'
import { showToast } from './ui/toast'
import type { VaultController } from './vault'

// ── Provenance helpers ───────────────────────────────────────────────────────

export function sourceLabel(source: FieldSourceDTO): string {
  switch (source.kind) {
    case 'profile':
      return 'set here'
    case 'group':
      return `from group ${source.label || source.id}`
    case 'credential':
      return `from credential ${source.label || source.id}`
    case 'sshConfig':
      return 'from ~/.ssh/config'
    case 'global':
      return 'from global defaults'
    case 'default':
      return 'default'
  }
}

// ── Probe outcome helpers ────────────────────────────────────────────────────

function probeOutcomeLabel(outcome: ProbeOutcome): string {
  switch (outcome) {
    case 'accepted':
      return 'Accepted'
    case 'rejected':
      return 'Rejected'
    case 'unreachable':
      return 'Unreachable'
    case 'host-key-problem':
      return 'Host key changed'
    case 'needs-interactive':
      return 'Needs interactive auth'
  }
}

// ── Save route decision (pure, tested directly) ─────────────────────────────

/** Describes how to save an existing profile for a given set of dirty fields. */
export type SaveRoute =
  { kind: 'noop' } | { kind: 'update' } | { kind: 'patch'; patchSet: Record<string, unknown> }

/**
 * Decide the save route for an existing profile given its dirty fields.
 *
 * When host or name are dirty, the full profile must go through
 * profiles.update because neither field is in the backend's
 * PatchPathAllowed set. When only options fields are dirty, send
 * just those fields through profiles.patch without pre-filtering:
 * the backend is the authority on what can be patched (nocx-fxs.1).
 *
 * Non-patchable fields: host (on SSHProfileOptions but not in
 * PatchPathAllowed), name (on Base).
 */
export function decideSaveRoute(profile: SSHProfile, dirty: ReadonlySet<string>): SaveRoute {
  if (dirty.size === 0) return { kind: 'noop' }

  const nonPatchable: Record<string, true> = { name: true, host: true, group: true }
  const hasNonPatchable = [...dirty].some((f) => nonPatchable[f])

  if (hasNonPatchable) {
    return { kind: 'update' }
  }

  const patchSet: Record<string, unknown> = {}
  for (const field of dirty) {
    patchSet[`options.${field}`] = profile.options[field as keyof typeof profile.options]
  }
  return { kind: 'patch', patchSet }
}

// ── Import sources ───────────────────────────────────────────────────────────

/**
 * Where a batch of connections can come from.
 *
 * `sshConfig` reads the machine's own ~/.ssh/config and takes no file; the
 * other two are files the user picks. That difference is why the dialog's file
 * picker is conditional rather than always shown and sometimes ignored.
 */
type ImportSource = 'sshConfig' | 'tabby' | 'backup'

// ── Props ────────────────────────────────────────────────────────────────────

export interface ConnectionsViewProps {
  client: ProfileClient
  vaultController?: VaultController
  onConnect?: (profile: SSHProfile) => void
  /**
   * Monotonic counter — every increment opens a blank profile for editing, the
   * same state the "+ New connection" button produces. A counter rather than a
   * callback ref because the page may not be rendered when the request is made:
   * mounting with a non-zero value is itself the request, which is what makes
   * the palette work on a Settings tab that was not open yet.
   */
  newProfileRequest?: number
  /**
   * Navigate from the Connections page to the Credentials page (in the same
   * Settings tab). The Connections page does not import CredentialsSection —
   * it asks its parent to show it, and the parent decides how.
   */
  onNavigateToCredentials?: () => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function ConnectionsView(props: ConnectionsViewProps) {
  // ── Data state ──────────────────────────────────────────────────────────
  const [profiles, setProfiles] = createSignal<SSHProfile[]>([])
  const [groups, setGroups] = createSignal<ProfileGroup[]>([])
  const [credentials, setCredentials] = createSignal<Credential[]>([])

  // ── Selection / dialog state ─────────────────────────────────────────────
  const [editing, setEditing] = createSignal<SSHProfile | null>(null)
  const [dialogOpen, setDialogOpen] = createSignal(false)
  const [profilePasswordOpen, setProfilePasswordOpen] = createSignal(false)
  const [profilePasswordValue, setProfilePasswordValue] = createSignal('')

  // ── Effective/provenance state ─────────────────────────────────────────
  const [effectiveData, setEffectiveData] = createSignal<Record<string, EffectiveProfileDTO>>({})
  const [dirtyFields, setDirtyFields] = createSignal<Set<string>>(new Set())
  const [profileMoveImpact, setProfileMoveImpact] = createSignal<GroupImpactResponse | null>(null)

  // ── Session state per profile ──────────────────────────────────────────
  const [sessionStatuses, setSessionStatuses] = createSignal<Record<string, SessionStatus>>({})

  // ── Connection test state per profile ────────────────────────────────
  const [probeBusy, setProbeBusy] = createSignal<Set<string>>(new Set())

  // ── Filter ─────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = createSignal('')

  // ── Quick-connect dialog (creation starts from one field) ─────────────
  const [quickConnectOpen, setQuickConnectOpen] = createSignal(false)
  const [quickConnectValue, setQuickConnectValue] = createSignal('')
  const [importSource, setImportSource] = createSignal<ImportSource>('sshConfig')
  const [importOpen, setImportOpen] = createSignal(false)
  const [importFile, setImportFile] = createSignal<File | null>(null)
  const [importBusy, setImportBusy] = createSignal(false)
  const [importPassphrase, setImportPassphrase] = createSignal('')
  const [previewResult, setPreviewResult] = createSignal<TabbyPreviewResponse | null>(null)
  const [previewOpen, setPreviewOpen] = createSignal(false)
  // Where the SSH config actually is, per the backend. Null until asked.
  const [sshConfigPath, setSSHConfigPath] = createSignal<SSHConfigPathResult | null>(null)

  // ── Inline credential creation dialog ─────────────────────────────────
  const [credDialogOpen, setCredDialogOpen] = createSignal(false)
  const [credDraft, setCredDraft] = createSignal<Credential | null>(null)
  const [credPasswordValue, setCredPasswordValue] = createSignal('')
  const credFormRef = { current: null as CredentialFormHandle | null }
  // ── Inline credential editing (profile editor) ──────────────────────
  const [profileCredDraft, setProfileCredDraft] = createSignal<Credential | null>(null)
  const [credentialUsage, setCredentialUsage] = createSignal<Record<string, number>>({})
  // ── Inline credential editing (group editor) ─────────────────────────
  const [groupCredDraft, setGroupCredDraft] = createSignal<Credential | null>(null)

  // ── Group editor dialog ──────────────────────────────────────────────
  const [editingGroup, setEditingGroup] = createSignal<ProfileGroup | null>(null)
  const [groupDialogOpen, setGroupDialogOpen] = createSignal(false)
  const [groupDraft, setGroupDraft] = createSignal<ProfileGroup | null>(null)
  const [groupImpact, setGroupImpact] = createSignal<GroupImpactResponse | null>(null)
  const [groupImpactBusy, setGroupImpactBusy] = createSignal(false)
  const [groupApplyBusy, setGroupApplyBusy] = createSignal(false)
  const [deleteGroupId, setDeleteGroupId] = createSignal<string | null>(null)

  /** The name behind deleteGroupId, for the confirmation to say out loud. */
  const deleteGroupName = createMemo(() => {
    const id = deleteGroupId()
    if (!id) return ''
    return groups().find((g) => g.id === id)?.name ?? ''
  })
  const [deleteImpact, setDeleteImpact] = createSignal<GroupImpactResponse | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = createSignal(false)
  const [deleteBusy, setDeleteBusy] = createSignal(false)
  const [dangerConfirmed, setDangerConfirmed] = createSignal(false)
  const [groupSection, setGroupSection] = createSignal('general')
  const [profileSection, setProfileSection] = createSignal('general')

  // ── Three-way key input state (publicKey auth) ───────────────────────
  type KeyInputMode = 'path' | 'file' | 'material'

  // Profile editor key state
  const [profileKeyMode, setProfileKeyMode] = createSignal<KeyInputMode>('path')
  const [profileKeyText, setProfileKeyText] = createSignal('')
  const [profileKeyFingerprint, setProfileKeyFingerprint] = createSignal<string | undefined>(
    undefined,
  )
  const [profileKeyTextError, setProfileKeyTextError] = createSignal<string | undefined>(undefined)

  // Group editor key state
  const [groupKeyMode, setGroupKeyMode] = createSignal<KeyInputMode>('path')
  const [groupKeyText, setGroupKeyText] = createSignal('')
  const [groupKeyFingerprint, setGroupKeyFingerprint] = createSignal<string | undefined>(undefined)
  const [groupKeyTextError, setGroupKeyTextError] = createSignal<string | undefined>(undefined)

  /** The impact, but only when it names a consequence. Null otherwise. */
  const groupImpactWorthShowing = createMemo(() => {
    const i = groupImpact()
    if (!i) return null
    if ((i.affectedProfiles?.length ?? 0) === 0 && !i.dangerous) return null
    return i
  })

  /**
   * The rail's sections. Fixed, and deliberately without a blast-radius entry:
   * the preview exists so that the consequence is seen BEFORE applying, and a
   * section is something the user can decline to open. It is pinned under the
   * pane instead, visible from whichever section made the change.
   */
  /**
   * The name is required, and the message belongs under the field: it is field
   * validation, answered by editing the field, and it clears as you type.
   */
  const groupValidation = createFormValidation({
    name: () => required('Name')(groupDraft()?.name ?? ''),
  })

  // ── Data loading ────────────────────────────────────────────────────────
  async function loadAll() {
    try {
      const [p, g, c] = await Promise.all([
        props.client.listProfiles(),
        props.client.listGroups(),
        props.client.listCredentials(),
      ])
      setProfiles(p ?? [])
      setGroups(g ?? [])
      setCredentials(c ?? [])
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to load connections', { message })
      showToast({
        level: 'danger',
        message: `Could not load connections: ${message}. The list may be out of date`,
      })
    }
  }

  async function loadCredentialUsage() {
    try {
      const result = await props.client.credentialUsage()
      const map: Record<string, number> = {}
      for (const entry of result.usage) {
        map[entry.credentialId] = entry.profiles.length
      }
      setCredentialUsage(map)
    } catch (err) {
      log.error('Failed to load credential usage', { message: (err as Error).message })
    }
  }

  // ── Credential draft management (inline editing) ──────────────────────

  createEffect(
    on(
      () => [editing()?.options?.credentialId, credentials()] as const,
      ([credId]) => {
        if (credId) {
          const cred = credentials().find((c) => c.id === credId)
          if (cred && (!profileCredDraft() || profileCredDraft()?.id !== credId)) {
            setProfileCredDraft({ ...cred })
          }
        } else {
          setProfileCredDraft(null)
        }
      },
    ),
  )

  createEffect(
    on(
      () => {
        const defaults = groupDraft()?.defaults
        return [
          defaults ? (defaults.credentialId as string | undefined) : undefined,
          credentials(),
        ] as const
      },
      ([credId]) => {
        if (credId) {
          const cred = credentials().find((c) => c.id === credId)
          if (cred) setGroupCredDraft({ ...cred })
        } else {
          setGroupCredDraft(null)
        }
      },
    ),
  )

  // ── Import ────────────────────────────────────────────────────────────

  const IMPORT_SOURCES = createMemo((): { value: ImportSource; label: string }[] => {
    const cfg = sshConfigPath()
    return [
      // The path is the backend's answer, not a guess. Until it arrives the
      // option is named without one rather than with a plausible fiction.
      { value: 'sshConfig', label: cfg?.path ? `SSH config (${cfg.path})` : 'SSH config' },
      { value: 'tabby', label: 'Tabby config (.yml/.yaml)' },
      { value: 'backup', label: 'nocx configuration export (.json)' },
    ]
  })

  const importHint = createMemo(() => {
    switch (importSource()) {
      case 'sshConfig': {
        const cfg = sshConfigPath()
        if (cfg && !cfg.available) {
          return 'This build has no SSH config reader wired, so there is nothing to import from.'
        }
        const where = cfg?.path ? `this machine’s ${cfg.path}` : 'this machine’s SSH config'
        return `Reads ${where} and saves its aliases as connections. An alias whose name or host is already saved is skipped, so running it twice is safe.`
      }
      case 'tabby':
        return 'Connections, groups and credentials from a Tabby configuration. A preview is shown before anything is written so you can review collisions and skipped secrets.'
      case 'backup':
    }
  })

  function openImportDialog() {
    setImportSource('sshConfig')
    setImportFile(null)
    setImportPassphrase('')
    setImportOpen(true)
    // Asked on open rather than on mount: it is only ever needed to draw this
    // dialog, and most sessions never open it.
    if (sshConfigPath() === null) {
      props.client
        .sshConfigPath()
        .then(setSSHConfigPath)
        .catch((err: unknown) => {
          // Not worth a toast — the label falls back to naming no path, and
          // the import itself reports its own failure if it comes to that.
          log.warn('Could not resolve the SSH config path', { message: (err as Error).message })
        })
    }
  }

  function closeImportDialog() {
    setImportOpen(false)
    setImportFile(null)
    setImportPassphrase('')
  }

  /**
   * An import that leaves credentials unmapped has half-succeeded, and the half
   * that failed needs the user to do something about it — so it is raised as a
   * sticky warning rather than a success that scrolls away in four seconds.
   */
  function reportImport(result: {
    profilesImported: number
    groupsImported: number
    credentialsImported: number
    unresolvedCredentials?: unknown[]
  }) {
    const summary =
      `Imported ${result.profilesImported} connections, ` +
      `${result.groupsImported} groups, ${result.credentialsImported} credentials`
    const unresolved = result.unresolvedCredentials?.length ?? 0
    if (unresolved > 0) {
      showToast({
        level: 'warning',
        duration: 0,
        message: `${summary} — ${unresolved} credentials need secret mapping`,
      })
      return
    }
    showToast({ level: 'success', message: summary })
  }

  async function runImport() {
    const source = importSource()
    const file = importFile()
    if (source !== 'sshConfig' && !file) {
      showToast({ level: 'warning', message: 'Choose a file to import' })
      return
    }

    setImportBusy(true)
    try {
      switch (source) {
        case 'sshConfig': {
          const { profilesImported, skipped } = await props.client.importSSHConfig()
          if (profilesImported === 0 && skipped === 0) {
            showToast({ level: 'info', message: 'No SSH config aliases to import' })
          } else if (skipped > 0) {
            // Sticky: "12 imported" alone reads as everything, and the
            // skipped ones are the part the user may want to go look at.
            showToast({
              level: 'warning',
              duration: 0,
              message:
                `Imported ${profilesImported} connections from ~/.ssh/config, ` +
                `${skipped} skipped (name or host already saved)`,
            })
          } else {
            showToast({
              level: 'success',
              message: `Imported ${profilesImported} connections from ~/.ssh/config`,
            })
          }
          break
        }
        case 'tabby': {
          // Preview first, then open preview dialog for confirmation.
          const preview = await props.client.tabbyPreview(
            await file!.text(),
            importPassphrase() || undefined,
          )
          setPreviewResult(preview)
          closeImportDialog()
          setPreviewOpen(true)
          break
        }
        case 'backup': {
          const data = JSON.parse(await file!.text()) as ConfigExport
          reportImport(await props.client.importConfig(data))
          break
        }
      }
      closeImportDialog()
      await loadAll()
    } catch (err) {
      const message = (err as Error).message
      log.error('Import failed', { source, message })
      showToast({ level: 'danger', message: `Import failed: ${message}` })
    } finally {
      setImportBusy(false)
    }
  }

  function closePreview() {
    setPreviewOpen(false)
    setPreviewResult(null)
  }

  async function executeImport() {
    const preview = previewResult()
    if (!preview) return

    const doExecute = async (): Promise<void> => {
      const result = await props.client.tabbyExecute(preview.planToken)
      setPreviewOpen(false)
      setPreviewResult(null)
      reportImport(result)
      await loadAll()
    }

    if (props.vaultController) {
      try {
        await props.vaultController.saveSecretWithVault(doExecute)
      } catch (err) {
        const message = (err as Error).message
        log.error('Tabby import failed', { message })
        showToast({ level: 'danger', message: `Tabby import failed: ${message}` })
      }
    } else {
      try {
        await doExecute()
      } catch (err) {
        const message = (err as Error).message
        log.error('Tabby import failed', { message })
        showToast({ level: 'danger', message: `Tabby import failed: ${message}` })
      }
    }
  }
  function openGroupEditor(group: ProfileGroup) {
    setEditingGroup(group)
    setGroupDraft(JSON.parse(JSON.stringify(group)) as ProfileGroup)
    setGroupImpact(null)
    setDangerConfirmed(false)
    setGroupSection('general')
    groupValidation.reset()
    setGroupKeyMode('path')
    setGroupKeyText('')
    setGroupKeyFingerprint(undefined)
    setGroupKeyTextError(undefined)
    setGroupDialogOpen(true)
  }

  /**
   * Open the group editor on a blank group.
   *
   * The id stays empty: the backend mints it on groups.create, the same way it
   * mints a profile id. A renderer that invented one would have to know the
   * store's uniqueness rule, and it is not the renderer's rule.
   */
  function startNewGroup() {
    openGroupEditor({ id: '', name: '' })
  }

  function closeGroupEditor() {
    setGroupDialogOpen(false)
    setEditingGroup(null)
    setGroupDraft(null)
    setGroupImpact(null)
    setGroupImpactBusy(false)
    setDangerConfirmed(false)
    setGroupKeyMode('path')
    setGroupKeyText('')
    setGroupKeyFingerprint(undefined)
    setGroupKeyTextError(undefined)
    setGroupCredDraft(null)
  }

  async function computeGroupImpact(draft: ProfileGroup) {
    if (!draft.id) return
    setDangerConfirmed(false)
    setGroupImpactBusy(true)
    try {
      const result = await props.client.groupImpact({ group: draft })
      setGroupImpact(result)
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to compute group impact', { message })
      setGroupImpact(null)
    } finally {
      setGroupImpactBusy(false)
    }
  }

  async function saveGroup() {
    const draft = groupDraft()
    if (!draft) return
    if (!groupValidation.valid()) {
      groupValidation.revealAll()
      // The offending field may be in a section the user is not looking at.
      // Reveal it there and the dialog reports nothing at all.
      setGroupSection('general')
      return
    }
    setGroupApplyBusy(true)
    try {
      // Key material save (publicKey paste mode in group defaults)
      const defaults = draft.defaults ?? {}
      if (
        !defaults.credentialId &&
        defaults.auth === 'publicKey' &&
        groupKeyMode() === 'material' &&
        groupKeyText()
      ) {
        const credential = await props.client.createCredential({
          id: '',
          name: draft.name,
          username: (defaults.user as string | undefined) ?? '',
          auth: 'publicKey',
        })
        const saveKeymat = async () => {
          const result = await props.client.saveKeyMaterial(credential.id, groupKeyText())
          setGroupKeyFingerprint(result.fingerprint)
        }
        if (props.vaultController) {
          await props.vaultController.saveSecretWithVault(saveKeymat)
        } else {
          await saveKeymat()
        }
        // Update the draft to link credential and remove keyPath
        const updatedDefaults: Record<string, unknown> = Object.fromEntries(
          Object.entries(defaults).filter(([k]) => k !== 'keyPath'),
        )
        updatedDefaults.credentialId = credential.id
        // The recursion below re-reads groupDraft(), so the updated draft has to
        // go back into the signal. Building it and dropping it meant the second
        // pass saved the ORIGINAL group — keyPath intact, credential unlinked —
        // while the key material sat in the vault owned by nobody.
        setGroupDraft({ ...draft, defaults: updatedDefaults } as ProfileGroup)
        setGroupKeyText('')
        // Recurse to save the updated draft
        return saveGroup()
      }

      // Save credential draft if the credential's fields were edited inline
      const credDraft = groupCredDraft()
      if (credDraft && credDraft.id) {
        const original = credentials().find((c) => c.id === credDraft.id)
        if (
          original &&
          (original.name !== credDraft.name ||
            original.username !== credDraft.username ||
            original.auth !== credDraft.auth)
        ) {
          await props.client.updateCredential(credDraft)
          // Update the local credentials list so stale data doesn't reappear
          setCredentials((prev) => prev.map((c) => (c.id === credDraft.id ? credDraft : c)))
          setGroupCredDraft(null)
        }

        // Key material save for an existing credential
        if (credDraft.auth === 'publicKey' && groupKeyMode() === 'material' && groupKeyText()) {
          const saveKeymat = async () => {
            const result = await props.client.saveKeyMaterial(credDraft.id, groupKeyText())
            setGroupKeyFingerprint(result.fingerprint)
          }
          if (props.vaultController) {
            await props.vaultController.saveSecretWithVault(saveKeymat)
          } else {
            await saveKeymat()
          }
          setGroupKeyText('')
          setGroupKeyFingerprint(undefined)
          setGroupKeyTextError(undefined)
        }
      }

      if (!draft.id) {
        await props.client.createGroup(draft)
      } else {
        await props.client.groupApply([draft])
      }
      closeGroupEditor()
      await loadAll()
      showToast({ level: 'success', message: `Saved group "${draft.name}"` })
    } catch (err) {
      if (
        err instanceof RpcError &&
        typeof err.data === 'object' &&
        err.data &&
        'reason' in err.data &&
        err.data.reason === 'invalid-key'
      ) {
        setGroupKeyTextError('Invalid private key format')
        log.error('Invalid key material in group defaults', { message: (err as Error).message })
        setGroupApplyBusy(false)
        return
      }
      const message = (err as Error).message
      log.error('Failed to save group', { message })
      showToast({ level: 'danger', message: `Could not save group: ${message}` })
    } finally {
      setGroupApplyBusy(false)
    }
  }

  function confirmDeleteGroup(group: ProfileGroup) {
    setDeleteGroupId(group.id)
    void computeDeleteImpact(group.id)
    setDeleteConfirmOpen(true)
  }

  async function computeDeleteImpact(groupId: string) {
    setDeleteBusy(true)
    try {
      const result = await props.client.groupImpact({ deleteGroupId: groupId })
      setDeleteImpact(result)
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to compute delete impact', { message })
      setDeleteImpact(null)
      showToast({ level: 'danger', message: `Could not preview deletion: ${message}` })
    } finally {
      setDeleteBusy(false)
    }
  }

  async function executeDeleteGroup() {
    const gid = deleteGroupId()
    if (!gid) return
    setDeleteBusy(true)
    try {
      await props.client.deleteGroup(gid)
      setDeleteConfirmOpen(false)
      setDeleteGroupId(null)
      setDeleteImpact(null)
      await loadAll()
      showToast({ level: 'success', message: 'Group deleted' })
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to delete group', { message })
      showToast({ level: 'danger', message: `Could not delete group: ${message}` })
    } finally {
      setDeleteBusy(false)
    }
  }

  function cancelDeleteGroup() {
    setDeleteConfirmOpen(false)
    setDeleteGroupId(null)
    setDeleteImpact(null)
  }

  function setGroupField(key: keyof ProfileGroup, value: unknown) {
    const current = groupDraft()
    if (!current) return
    const updated = { ...current, [key]: value }
    setGroupDraft(updated)
    void computeGroupImpact(updated)
  }

  function setGroupDefaultsField(key: string, value: unknown) {
    const current = groupDraft()
    if (!current) return
    // Convert types based on field — the backend expects typed sparse values.
    let typed: unknown = value
    if (value === '' || value === undefined || value === null) {
      typed = undefined // unset — let the empty delete below handle it
    } else {
      const numericFields = new Set([
        'port',
        'keepaliveInterval',
        'keepaliveCountMax',
        'readyTimeout',
      ])
      if (numericFields.has(key)) {
        const n = Number(value)
        typed = isNaN(n) ? undefined : n
      } else if (key === 'agentForward') {
        typed = value === true || value === 'true'
      }
    }
    const defaults = { ...(current.defaults || {}), [key]: typed }
    if (typed === undefined || typed === null) {
      delete defaults[key]
    }
    const updated = { ...current, defaults } as ProfileGroup
    setGroupDraft(updated)
    void computeGroupImpact(updated)
  }

  /**
   * The group's defaults, split the way the connection editor splits the same
   * settings. Nine fields in one list is what made this dialog a tube; they
   * were never one subject anyway — a credential and a keepalive interval are
   * not read at the same moment.
   */
  const CONNECTION_DEFAULTS: { key: string; label: string }[] = [
    { key: 'port', label: 'Port' },
    { key: 'jumpHost', label: 'Jump server' },
  ]

  const ADVANCED_DEFAULTS: { key: string; label: string }[] = [
    { key: 'keepaliveInterval', label: 'Keepalive interval (ms)' },
    { key: 'keepaliveCountMax', label: 'Keepalive count max' },
    { key: 'readyTimeout', label: 'Ready timeout (ms)' },
    { key: 'agentForward', label: 'Agent forward' },
  ]

  /** Human-readable field labels for the impact summary. */
  function fieldLabel(key: string): string {
    const m: Record<string, string> = {
      credentialId: 'credential',
      port: 'port',
      user: 'username',
      auth: 'auth mode',
      jumpHost: 'jump server',
      keepaliveInterval: 'keepalive interval',
      keepaliveCountMax: 'keepalive count max',
      readyTimeout: 'ready timeout',
      agentForward: 'agent forwarding',
    }
    return m[key] ?? key
  }

  function renderImpactSummary(impact: GroupImpactResponse): JSX.Element {
    const profiles = impact.affectedProfiles ?? []
    const dangerous = impact.dangerous
    if (profiles.length === 0) return <p class="cm-impact-none">No connections affected</p>

    const dangerousCount = profiles.filter((p) => p.diffs.some((d) => d.dangerous)).length

    return (
      <div class="cm-impact">
        <p class="cm-impact-count" role="status">
          Affects <strong>{profiles.length}</strong> connection{profiles.length === 1 ? '' : 's'}
          <Show when={dangerous}>
            <span class="cm-impact-dangerous"> &middot; includes auth-affecting changes</span>
          </Show>
        </p>
        <Show when={dangerous}>
          <div class="cm-impact-danger-badge" role="alert">
            This change affects authentication for {dangerousCount} connection
            {dangerousCount === 1 ? '' : 's'} and requires explicit confirmation.
          </div>
        </Show>
        <table class="cm-impact-table" role="list">
          <For each={profiles}>
            {(pi) => (
              <tr class="cm-impact-row" role="listitem">
                <td class="cm-impact-profile">{pi.profileName}</td>
                <td class="cm-impact-diffs">
                  <For each={pi.diffs}>
                    {(d) => (
                      <span
                        class="cm-impact-diff"
                        classList={{ 'cm-impact-diff-dangerous': d.dangerous }}
                      >
                        <Show when={d.dangerous} fallback={<Badge tone="warning">changed</Badge>}>
                          <Badge tone="danger">dangerous</Badge>
                        </Show>
                        {fieldLabel(d.field)}:{' '}
                        {typeof d.oldValue === 'string'
                          ? d.oldValue
                          : (JSON.stringify(d.oldValue) ?? '(none)')}{' '}
                        →{' '}
                        {typeof d.newValue === 'string'
                          ? d.newValue
                          : (JSON.stringify(d.newValue) ?? '(none)')}
                      </span>
                    )}
                  </For>
                </td>
              </tr>
            )}
          </For>
        </table>
      </div>
    )
  }
  function renderGroupEditor(): JSX.Element {
    // Read inside the accessors, never once at the top. A read up here makes
    // the whole editor one computation, so every keystroke rebuilt the form's
    // DOM and took the caret with it — the field lost focus after the first
    // character typed. Read per value and Solid updates the one attribute.
    function gv(key: string): unknown {
      const draft = groupDraft()
      if (!draft) return undefined
      if (key === 'name') return draft.name
      if (key === 'description') return draft.description ?? ''
      return (draft.defaults ?? {})[key]
    }

    function setG(key: string, v: string) {
      if (key === 'name' || key === 'description') {
        setGroupField(key, v)
      } else {
        setGroupDefaultsField(key, v)
      }
    }
    const jumpOptions = createMemo((): SelectOption[] =>
      jumpServerProfiles().map((p) => ({
        value: p.id,
        label: p.name,
      })),
    )

    // Not a component — a render helper for one row, so the fields are read
    // once at call time on purpose. Named parameters would trip the
    // no-destructure rule, which cannot tell the two apart.
    function renderDefault(field: { key: string; label: string }): JSX.Element {
      const key = field.key
      const label = field.label
      if (key === 'jumpHost') {
        return (
          <Field for={`group-default-${key}`} label={label}>
            <div class="cm-field-row">
              <Select
                value={gv(key) as string}
                onChange={(v) => setG(key, v || '')}
                options={jumpOptions()}
                placeholder="&mdash; Not set (inherit) &mdash;"
              />
            </div>
          </Field>
        )
      }
      if (key === 'agentForward') {
        return (
          <Checkbox
            label={label}
            checked={gv(key) === true}
            onChange={(v) => setG(key, v ? 'true' : '')}
          />
        )
      }
      return (
        <TextField
          id={`group-default-${key}`}
          label={label}
          value={gv(key) != null ? String(gv(key)) : ''}
          type={
            key === 'port' ||
            key.includes('Timeout') ||
            key.includes('Count') ||
            key.includes('interval')
              ? 'number'
              : 'text'
          }
          onInput={(v) => setG(key, v)}
          placeholder="&mdash; Not set (inherit) &mdash;"
        />
      )
    }

    function renderDefaults(fields: { key: string; label: string }[]): JSX.Element {
      return (
        <Stack>
          <p class="cm-hint">
            Inherited by every connection in this group and its subgroups, unless the connection
            overrides it.
          </p>
          <For each={fields}>{(f) => renderDefault(f)}</For>
        </Stack>
      )
    }

    /** When a credential is selected, keyPath lives on the credential draft. */
    const groupKeyPathValue = () => {
      const cred = groupCredDraft()
      if (cred) return cred.keyPath ?? ''
      return (gv('keyPath') as string | undefined) ?? ''
    }
    function handleGroupKeyPathChange(v: string | undefined) {
      const cred = groupCredDraft()
      if (cred) {
        setGroupCredDraft({ ...cred, keyPath: v })
      } else {
        setGroupDefaultsField('keyPath', v || undefined)
      }
    }
    function renderConnectionDefaults(): JSX.Element {
      const auth = gv('auth')
      return (
        <Stack>
          <p class="cm-hint">
            Inherited by every connection in this group and its subgroups, unless the connection
            overrides it.
          </p>
          <AuthenticationEditor
            id="group-default-auth"
            credentials={credentials()}
            credentialId={(gv('credentialId') as string | undefined) || undefined}
            onCredentialChange={(value) => setGroupDefaultsField('credentialId', value)}
            username={(gv('user') as string | undefined) || undefined}
            onUsernameChange={(value) => setGroupDefaultsField('user', value)}
            auth={auth === undefined ? undefined : (auth as AuthMode)}
            onAuthChange={(value) => setGroupDefaultsField('auth', value)}
            credentialDraft={groupCredDraft() ?? undefined}
            onCredentialDraftChange={(draft) => setGroupCredDraft(draft)}
            credentialUsage={groupCredDraft() ? credentialUsage()[groupCredDraft()!.id] : undefined}
            publicKeyAction={
              <Field for="group-default-key" label="Private Key">
                <SegmentedControl
                  options={[
                    { value: 'path', label: 'Path' },
                    { value: 'file', label: 'Choose file' },
                    { value: 'material', label: 'Paste key' },
                  ]}
                  value={groupKeyMode()}
                  onChange={(value) => {
                    const prev = groupKeyMode()
                    if (value === 'material') {
                      handleGroupKeyPathChange(undefined)
                    } else if (prev === 'material') {
                      const credId = gv('credentialId') as string | undefined
                      setGroupKeyText('')
                      setGroupKeyFingerprint(undefined)
                      setGroupKeyTextError(undefined)
                      if (!groupCredDraft()) {
                        setGroupDefaultsField('credentialId', undefined)
                      }
                      if (credId) {
                        props.client.deleteKeyMaterial(credId).catch((err: unknown) => {
                          log.error('Failed to delete key material', {
                            message: (err as Error).message,
                          })
                        })
                      }
                    }
                    if (value === 'path' || value === 'file') {
                      setGroupKeyText('')
                      setGroupKeyFingerprint(undefined)
                      setGroupKeyTextError(undefined)
                    }
                    setGroupKeyMode(value as KeyInputMode)
                  }}
                  ariaLabel="Key input mode"
                />
                <Show when={groupKeyMode() === 'path'}>
                  <TextField
                    id="group-default-key-path"
                    label="Private Key Path"
                    value={groupKeyPathValue()}
                    onInput={(value) => handleGroupKeyPathChange(value || undefined)}
                    placeholder="— Not set (inherit) —"
                  />
                </Show>
                <Show when={groupKeyMode() === 'file'}>
                  <FileInput
                    accept="*"
                    onChange={(file) => {
                      if (file) {
                        const filePath = (file as File & { path?: string })?.path ?? file.name
                        handleGroupKeyPathChange(filePath)
                      }
                    }}
                    ariaLabel="Choose private key file"
                    buttonLabel="Choose file…"
                  />
                </Show>
                <Show when={groupKeyMode() === 'material'}>
                  <TextField
                    multiline
                    id="group-default-key-text"
                    label="Private Key"
                    value={groupKeyText()}
                    onInput={(value) => {
                      setGroupKeyText(value)
                      setGroupKeyTextError(undefined)
                    }}
                    placeholder="Paste the private key content here"
                    error={groupKeyTextError()}
                  />
                  <Show when={groupKeyFingerprint()}>
                    <span class="cm-key-fingerprint">Fingerprint: {groupKeyFingerprint()}</span>
                  </Show>
                </Show>
              </Field>
            }
          />
          <For each={CONNECTION_DEFAULTS}>{(field) => renderDefault(field)}</For>
        </Stack>
      )
    }

    return (
      <div class="cm-group-form">
        <Tabs
          items={[
            {
              id: 'general',
              label: 'General',
              content: () => (
                <Stack>
                  <TextField
                    id="group-name"
                    label="Name"
                    required
                    value={gv('name') as string}
                    error={groupValidation.error('name')}
                    onInput={(v) => setG('name', v)}
                    onBlur={() => groupValidation.touch('name')}
                  />
                  <TextField
                    id="group-description"
                    label="Description"
                    value={gv('description') as string}
                    onInput={(v) => setG('description', v)}
                  />
                </Stack>
              ),
            },
            {
              id: 'connection',
              label: 'Connection',
              content: renderConnectionDefaults,
            },
            {
              id: 'advanced',
              label: 'Advanced',
              content: () => renderDefaults(ADVANCED_DEFAULTS),
            },
          ]}
          active={groupSection()}
          onChange={setGroupSection}
          ariaLabel="Group sections"
        />

        {/* Pinned under the pane, not filed as a section. What a change is
            about to do to other connections has to be in front of the person
            making it, and a section is something you can decline to open. */}
        {/* Only when it has something to say. The block is a warning, and a
            warning that fires on every edit to report that nothing happened
            teaches the reader to stop looking at it — which is exactly the
            moment it needs to be read. */}
        <Show when={groupImpactWorthShowing()}>
          {(i) => (
            <div class="cm-group-impact">
              <Show when={!groupImpactBusy()} fallback={<p>Computing impact…</p>}>
                {renderImpactSummary(i())}
                <Show when={i().dangerous}>
                  <div class="cm-danger-confirm">
                    <Checkbox
                      label="I understand this will change authentication for affected connections"
                      checked={dangerConfirmed()}
                      onChange={(v) => setDangerConfirmed(v)}
                    />
                  </div>
                </Show>
              </Show>
            </div>
          )}
        </Show>
      </div>
    )
  }

  async function loadEffective(ids: string[]) {
    if (ids.length === 0) return
    try {
      const res = await props.client.loadEffective(ids)
      setEffectiveData((prev) => {
        const next = { ...prev }
        for (const eff of res.profiles) {
          next[eff.id] = eff
        }
        return next
      })
    } catch (err) {
      log.error('Failed to load effective data', { message: (err as Error).message })
    }
  }

  async function loadSessionStatuses() {
    const pids = profiles().map((x) => x.id)
    if (pids.length === 0) return
    try {
      const res = await props.client.sessionStatus(pids)
      setSessionStatuses(res.statuses ?? {})
    } catch (err) {
      log.error('Failed to load session status', { message: (err as Error).message })
    }
  }

  async function handleTest(profile: SSHProfile) {
    setProbeBusy((prev) => new Set(prev).add(profile.id))
    try {
      const res = await props.client.connectionTest(profile.id)
      showToast({
        level: res.outcome === 'accepted' ? 'success' : 'warning',
        message: res.detail
          ? `${probeOutcomeLabel(res.outcome)}: ${res.detail}`
          : probeOutcomeLabel(res.outcome),
      })
    } catch (err) {
      const message = (err as Error).message
      log.error('Connection test failed', { profileId: profile.id, message })
      showToast({ level: 'danger', message: `Test failed: ${message}` })
    } finally {
      setProbeBusy((prev) => {
        const next = new Set(prev)
        next.delete(profile.id)
        return next
      })
    }
  }

  // Initial load on mount — profiles, session status, and effective data.
  // loadAll triggers loadSessionStatuses and loadEffective internally after
  // profiles are set, so the async continuation does not need to be tracked.
  onMount(() => {
    void loadAll()
    void loadCredentialUsage()
  })

  // After profiles load, fetch session status and effective data for them.
  createEffect(
    on(
      () =>
        profiles()
          .map((x) => x.id)
          .join(','),
      (ids) => {
        if (!ids) return
        void loadSessionStatuses()
        void loadEffective(ids.split(','))
      },
    ),
  )
  // The palette's "New connection" request.
  createEffect(
    on(
      () => props.newProfileRequest ?? 0,
      (n) => {
        if (n > 0) startNewProfile()
      },
    ),
  )

  // ── Form / dialog helpers ─────────────────────────────────────────────

  function startNewProfile() {
    setQuickConnectValue('')
    setQuickConnectOpen(true)
  }

  function closeQuickConnect() {
    setQuickConnectOpen(false)
    setQuickConnectValue('')
  }

  function handleQuickConnect() {
    const q = quickConnectValue().trim()
    if (!q) {
      showToast({ level: 'warning', message: 'Enter a host, alias, or connection string' })
      return
    }

    const parsed = parseQuickConnect(q)
    const profile: SSHProfile = {
      id: '',
      type: 'ssh',
      name: parsed.options.host || 'New connection',
      options: {
        host: parsed.options.host,
        port: parsed.options.port ?? 22,
        user: parsed.options.user ?? '',
        auth: '',
      },
    }

    // If the input had an ssh:// prefix, that's expected — nothing lost.
    // Report any other part that didn't survive: if the original contained
    // an '@' or ':' but parsing left the host empty, the format was wrong.
    const hadAtOrColon = q.includes('@') || q.includes(':')
    if (!parsed.options.host && hadAtOrColon) {
      showToast({
        level: 'warning',
        message: `Could not parse "${q}": try "user@host:port" or "ssh://user@host:port"`,
      })
    }

    closeQuickConnect()
    setProfileSection('general')
    setEditing(profile)
    setDirtyFields(new Set<string>())
    profileValidation.reset()
    setProfileKeyMode('path')
    setProfileKeyText('')
    setProfileKeyFingerprint(undefined)
    setProfileKeyTextError(undefined)
    setDialogOpen(true)
  }

  function openEditDialog(profile: SSHProfile) {
    setProfileSection('general')
    setEditing(profile)
    setDirtyFields(new Set<string>())
    profileValidation.reset()
    setProfileKeyMode('path')
    setProfileKeyText('')
    setProfileKeyFingerprint(undefined)
    setProfileKeyTextError(undefined)
    setDialogOpen(true)
  }

  function closeDialog() {
    setDialogOpen(false)
    setEditing(null)
    setProfilePasswordOpen(false)
    setProfilePasswordValue('')
    setDirtyFields(new Set<string>())
    setProfileMoveImpact(null)
    setProfileKeyMode('path')
    setProfileKeyText('')
    setProfileKeyFingerprint(undefined)
    setProfileKeyTextError(undefined)
    setProfileCredDraft(null)
  }

  // ── Validation ──────────────────────────────────────────────────────────

  const formProfile = createMemo<SSHProfile | null>(() => {
    return editing()
  })

  const profileValidation = createFormValidation({
    name: () => required('Name')(formProfile()?.name ?? ''),
    host: () => combine(required('Host'), hostname())(formProfile()?.options.host ?? ''),
    port: () => combine(required('Port'), portRule())(String(formProfile()?.options.port ?? '')),
    keepaliveInterval: () =>
      nonNegativeInteger('Keepalive interval')(
        String(formProfile()?.options.keepaliveInterval ?? ''),
      ),
    keepaliveCountMax: () =>
      nonNegativeInteger('Keepalive count max')(
        String(formProfile()?.options.keepaliveCountMax ?? ''),
      ),
    readyTimeout: () =>
      nonNegativeInteger('Ready timeout')(String(formProfile()?.options.readyTimeout ?? '')),
  })

  function gate(validation: {
    valid(): boolean
    revealAll(): void
    firstError(): string | undefined
  }) {
    if (validation.valid()) return true
    validation.revealAll()
    const message = validation.firstError()
    if (message) showToast({ level: 'warning', message })
    return false
  }

  // ── Save / delete / connect ────────────────────────────────────────────

  async function saveProfile(profile: SSHProfile) {
    if (!gate(profileValidation)) return

    if (
      !profile.options.credentialId &&
      profile.options.auth === 'password' &&
      profilePasswordValue()
    ) {
      try {
        const credential = await props.client.createCredential({
          id: '',
          name: profile.name,
          username: profile.options.user ?? '',
          auth: 'password',
        })
        const savePw = async () => {
          await props.client.savePassword(credential.id, profilePasswordValue())
        }
        if (props.vaultController) {
          await props.vaultController.saveSecretWithVault(savePw)
        } else {
          await savePw()
        }
        const linked = {
          ...profile,
          options: { ...profile.options, credentialId: credential.id },
        }
        setEditing(linked)
        setProfilePasswordValue('')
        setDirtyFields((prev) => new Set(prev).add('credentialId'))
        await saveProfile(linked)
      } catch (err) {
        const message = (err as Error).message
        log.error('Failed to save inline password credential', { message })
        showToast({ level: 'danger', message: `Could not save the password: ${message}` })
      }
      return
    }

    // Key material save (publicKey paste mode)
    if (
      !profile.options.credentialId &&
      profile.options.auth === 'publicKey' &&
      profileKeyMode() === 'material' &&
      profileKeyText()
    ) {
      try {
        const credential = await props.client.createCredential({
          id: '',
          name: profile.name,
          username: profile.options.user ?? '',
          auth: 'publicKey',
        })
        const saveKeymat = async () => {
          const result = await props.client.saveKeyMaterial(credential.id, profileKeyText())
          setProfileKeyFingerprint(result.fingerprint)
        }
        if (props.vaultController) {
          await props.vaultController.saveSecretWithVault(saveKeymat)
        } else {
          await saveKeymat()
        }
        const linked = {
          ...profile,
          options: { ...profile.options, credentialId: credential.id, keyPath: undefined },
        }
        setEditing(linked)
        setProfileKeyText('')
        setDirtyFields((prev) => new Set(prev).add('credentialId'))
        await saveProfile(linked)
      } catch (err) {
        if (
          err instanceof RpcError &&
          typeof err.data === 'object' &&
          err.data &&
          'reason' in err.data &&
          err.data.reason === 'invalid-key'
        ) {
          setProfileKeyTextError('Invalid private key format')
          log.error('Invalid key material', { message: (err as Error).message })
          return
        }
        const message = (err as Error).message
        log.error('Failed to save key material', { message })
        showToast({ level: 'danger', message: `Could not save the key: ${message}` })
      }
      return
    }
    // Save credential draft if the credential's fields were edited inline
    const credDraft = profileCredDraft()
    if (credDraft && credDraft.id) {
      const original = credentials().find((c) => c.id === credDraft.id)
      if (
        original &&
        (original.name !== credDraft.name ||
          original.username !== credDraft.username ||
          original.auth !== credDraft.auth)
      ) {
        try {
          await props.client.updateCredential(credDraft)
          // Update the local credentials list so stale data doesn't reappear
          // on the next editor open.
          setCredentials((prev) => prev.map((c) => (c.id === credDraft.id ? credDraft : c)))
          setProfileCredDraft(null)
        } catch (err) {
          const message = (err as Error).message
          log.error('Failed to update credential', { message })
          showToast({ level: 'danger', message: `Could not update credential: ${message}` })
          return
        }
      }

      // Password save for an existing credential
      if (profilePasswordValue()) {
        const savePw = async () => {
          await props.client.savePassword(credDraft.id, profilePasswordValue())
        }
        if (props.vaultController) {
          await props.vaultController.saveSecretWithVault(savePw)
        } else {
          await savePw()
        }
        setProfilePasswordValue('')
      }

      // Key material save for an existing credential
      if (credDraft.auth === 'publicKey' && profileKeyMode() === 'material' && profileKeyText()) {
        const saveKeymat = async () => {
          const result = await props.client.saveKeyMaterial(credDraft.id, profileKeyText())
          setProfileKeyFingerprint(result.fingerprint)
        }
        if (props.vaultController) {
          await props.vaultController.saveSecretWithVault(saveKeymat)
        } else {
          await saveKeymat()
        }
        setProfileKeyText('')
        setProfileKeyFingerprint(undefined)
        setProfileKeyTextError(undefined)
      }
    }
    const isNew = !profile.id || !profiles().some((x) => x.id === profile.id)

    if (isNew) {
      try {
        const saved = await props.client.createProfile(profile)
        closeDialog()
        await loadAll()
        void loadSessionStatuses()
        void loadEffective([saved.id])
        showToast({ level: 'success', message: `Saved "${saved.name}"` })
      } catch (err) {
        const message = (err as Error).message
        log.error('Failed to save', { message })
        showToast({ level: 'danger', message: `Could not save the connection: ${message}` })
      }
      return
    }

    const dirty = new Set(dirtyFields())
    // If the group changed from the original, force a full update.
    const origProfile = profiles().find((p) => p.id === profile.id)
    if (origProfile && origProfile.group !== profile.group) {
      dirty.add('group')
    }
    const route = decideSaveRoute(profile, dirty)

    switch (route.kind) {
      case 'noop':
        closeDialog()
        return

      case 'update':
        try {
          const saved = await props.client.updateProfile(profile)
          closeDialog()
          await loadAll()
          await loadEffective([saved.id])
          void loadSessionStatuses()
          showToast({ level: 'success', message: `Saved "${saved.name}"` })
        } catch (err) {
          const message = (err as Error).message
          log.error('Failed to save', { message })
          showToast({ level: 'danger', message: `Could not save the connection: ${message}` })
        }
        return

      case 'patch':
        try {
          const eff = await props.client.patchProfile({ id: profile.id, set: route.patchSet })
          setEffectiveData((prev) => ({ ...prev, [profile.id]: eff }))
          closeDialog()
          showToast({ level: 'success', message: `Saved "${profile.name}"` })
        } catch (err) {
          const message = (err as Error).message
          log.error('Failed to save', { message })
          showToast({ level: 'danger', message: `Could not save the connection: ${message}` })
        }
        return
    }
  }

  async function computeMoveImpact(profileId: string, targetGroupId: string) {
    setProfileMoveImpact(null)
    try {
      const result = await props.client.moveImpact({ profileIds: [profileId], targetGroupId })
      setProfileMoveImpact(result)
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to compute move impact', { message })
      setProfileMoveImpact(null)
    }
  }

  async function deleteProfile(profile: SSHProfile) {
    if (!(await showConfirm(`Delete "${profile.name}"?`))) return
    try {
      await props.client.deleteProfile(profile.id)
      closeDialog()
      await loadAll()
      void loadSessionStatuses()
      showToast({ level: 'success', message: `Deleted "${profile.name}"` })
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to delete profile', { message })
      showToast({ level: 'danger', message: `Could not delete "${profile.name}": ${message}` })
    }
  }

  // ── Inline credential creation (from within connection form) ────────────

  function openCredDialog() {
    const profile = editing()
    const username = profile?.options.user?.trim() ?? ''
    const host = profile?.options.host?.trim() ?? ''
    const connectionName = profile?.name.trim() ?? ''
    const endpointName = username && host ? `${username}@${host}` : host

    setCredDraft({
      id: '',
      name: connectionName || endpointName || 'SSH credential',
      username,
      auth: profile?.options.auth ?? '',
    })
    setCredPasswordValue('')
    credFormRef.current?.reset()
    // This is a drill-in from the connection editor, not a second decision
    // layered over it. Keep the connection draft in memory and hand the single
    // modal slot to the credential editor.
    setDialogOpen(false)
    setCredDialogOpen(true)
  }

  function closeCredDialog() {
    setCredDialogOpen(false)
    setCredDraft(null)
    setCredPasswordValue('')
    // Return to the connection draft on both Save and Cancel.
    if (editing()) setDialogOpen(true)
  }

  async function handleCredSave() {
    const cred = credDraft()
    if (!cred) return
    if (!credFormRef.current?.valid()) {
      credFormRef.current?.revealAll()
      const msg = credFormRef.current?.error('name') ?? 'Please fill in all required fields'
      showToast({ level: 'warning', message: msg })
      return
    }

    try {
      const saved = await props.client.createCredential(cred)

      if (cred.auth === 'password' && credPasswordValue()) {
        const savePw = async () => {
          await props.client.savePassword(saved.id, credPasswordValue())
        }
        if (props.vaultController) {
          await props.vaultController.saveSecretWithVault(savePw)
        } else {
          await savePw()
        }
      }

      // Refresh the credential list and select the new one
      const updated = await props.client.listCredentials()
      setCredentials(updated ?? [])

      // Select the new credential on the connection being edited
      const p = editing()
      if (p) {
        const updatedProfile = { ...p, options: { ...p.options, credentialId: saved.id } }
        setEditing(updatedProfile)
        setDirtyFields((prev: Set<string>) => {
          const next = new Set(prev)
          next.add('credentialId')
          return next
        })
      }

      closeCredDialog()
      showToast({ level: 'success', message: `Created credential "${saved.name}"` })
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to create credential from form', { message })
      showToast({ level: 'danger', message: `Could not create credential: ${message}` })
    }
  }
  // ── Derived data ──────────────────────────────────────────────────────

  const jumpServerProfiles = createMemo(() => profiles().filter((p) => p.options.canBeJumpServer))

  // ── Filtered + grouped list ──────────────────────────────────────────

  const filteredProfiles = createMemo(() => {
    const q = searchQuery().toLowerCase()
    if (!q) return profiles()
    return profiles().filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.options.host.toLowerCase().includes(q) ||
        (p.options.user || '').toLowerCase().includes(q),
    )
  })

  const tree = createMemo(() => buildGroupTree(groups()))

  const ungrouped = createMemo(() =>
    filteredProfiles().filter((p) => !p.group || !groups().some((g) => g.id === p.group)),
  )

  // Profiles in each group, filtered
  function groupProfiles(groupId: string): SSHProfile[] {
    return filteredProfiles().filter((p) => p.group === groupId)
  }

  // ── Row render helpers ───────────────────────────────────────────────

  function renderRow(p: SSHProfile) {
    const status = () => sessionStatuses()[p.id]
    const isTesting = () => probeBusy().has(p.id)

    // Credential lookup
    const eff = () => effectiveData()[p.id]
    const effCredId = () => {
      const e = eff()
      return e?.fields?.credentialId?.value as string | undefined
    }
    const credObj = () => credentials().find((c) => c.id === effCredId())
    const credSource = () => {
      const e = eff()
      return e?.fields?.credentialId?.source
    }

    return (
      <CollectionRow
        info={
          <>
            <div class="cm-item-name">{p.name}</div>
            <div class="cm-item-meta">
              <Badge tone="neutral">{p.type.toUpperCase()}</Badge>
              <span class="cm-item-address">
                {p.options.user ? `${p.options.user}@` : ''}
                {p.options.host}:{p.options.port || 22}
              </span>
              {/* Session state — Show with keyed narrows the type */}
              <Show when={status()} keyed>
                {(st) => (
                  <span
                    class="cm-session-state"
                    classList={{ 'cm-session-live': st.live }}
                    role="status"
                    aria-label={st.live ? 'Connected' : 'Disconnected'}
                  >
                    <span class="cm-session-dot" aria-hidden="true" />
                    {st.live ? 'Connected' : 'Disconnected'}
                    <Show when={st.lastUsed} keyed>
                      {(lastUsed) => (
                        <span class="cm-session-last-used">
                          &middot; last used {new Date(lastUsed).toLocaleDateString()}
                        </span>
                      )}
                    </Show>
                  </span>
                )}
              </Show>
            </div>
            {/* Credential info */}
            <Show when={credObj()} keyed>
              {(cred) => (
                <div class="cm-item-credential">
                  <span class="cm-credential-key">Credential:</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => props.onNavigateToCredentials?.()}
                    ariaLabel={`Open credentials for ${cred.name}`}
                  >
                    {cred.name}
                  </Button>
                  <Show when={credSource()} keyed>
                    {(src) => <span class="cm-provenance-label">{sourceLabel(src)}</span>}
                  </Show>
                </div>
              )}
            </Show>
          </>
        }
        actions={
          <>
            <IconButton
              size="sm"
              title="Edit"
              ariaLabel={`Edit ${p.name}`}
              onClick={() => openEditDialog(p)}
            >
              <PencilIcon />
            </IconButton>
            <Button
              variant="ghost"
              size="sm"
              disabled={isTesting()}
              onClick={() => void handleTest(p)}
              ariaLabel={`Test connection to ${p.name}`}
            >
              <CheckCircleIcon />
              {isTesting() ? 'Testing...' : 'Test'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Connect"
              ariaLabel={`Connect to ${p.name}`}
              onClick={() => props.onConnect?.(p)}
            >
              <PlugIcon />
              Connect
            </Button>
          </>
        }
      />
    )
  }

  /** Does this group, or anything under it, hold a connection the filter kept? */
  function groupHasMatches(node: TreeNode): boolean {
    if (groupProfiles(node.id).length > 0) return true
    return node.children.some((c) => groupHasMatches(c))
  }

  function renderGroupSection(node: TreeNode) {
    // An empty group used to render nothing at all, so creating one looked
    // like the button had failed — and with no header there was no way to
    // reach its editor to rename or delete it either. While a filter is
    // active it is noise, so that is the only case that still hides it.
    if (searchQuery().trim() !== '' && !groupHasMatches(node)) return null
    const gp = groupProfiles(node.id)
    return (
      <>
        <div class="cm-group-header" role="heading" aria-level={2}>
          <span class="cm-group-name">{node.name}</span>
          <span class="cm-group-actions">
            <IconButton
              size="sm"
              title="Edit group"
              ariaLabel={`Edit group ${node.name}`}
              onClick={() => openGroupEditor(node)}
            >
              <PencilIcon />
            </IconButton>
            <IconButton
              size="sm"
              title="Delete group"
              ariaLabel={`Delete group ${node.name}`}
              onClick={() => confirmDeleteGroup(node)}
            >
              <TrashIcon />
            </IconButton>
          </span>
        </div>
        <Show when={gp.length === 0 && node.children.length === 0}>
          <p class="cm-group-empty">
            No connections here yet — pick this group in a connection&rsquo;s editor to move it in.
          </p>
        </Show>
        <For each={gp}>{(p) => renderRow(p)}</For>
        <For each={node.children}>{(child) => renderGroupSection(child)}</For>
      </>
    )
  }

  // ── Dialog form (profile editor) ──────────────────────────────────────

  function renderProfileForm(profile: SSHProfile) {
    function setOption(key: keyof SSHProfile['options'], value: unknown) {
      const updated = { ...profile, options: { ...profile.options, [key]: value } }
      setEditing(updated)
      setDirtyFields((prev: Set<string>) => {
        const next = new Set(prev)
        next.add(key)
        return next
      })
    }

    function onNameChange(v: string) {
      const updated = { ...profile, name: v }
      setEditing(updated)
      setDirtyFields((prev: Set<string>) => {
        const next = new Set(prev)
        next.add('name')
        return next
      })
    }

    /** When a credential is selected, keyPath lives on the credential draft. */
    const keyPathValue = () => {
      const cred = profileCredDraft()
      if (cred) return cred.keyPath ?? ''
      return fvStr('keyPath')
    }
    function handleKeyPathChange(v: string | undefined) {
      const cred = profileCredDraft()
      if (cred) {
        setProfileCredDraft({ ...cred, keyPath: v })
      } else {
        setOption('keyPath', v || undefined)
      }
    }

    function effField(field: string): EffectiveFieldDTO | undefined {
      const eff = effectiveData()[profile.id]
      return eff?.fields[field]
    }

    function fieldValue(key: string): unknown {
      const dirty = dirtyFields()
      if (dirty.has(key)) {
        const draft = editing()
        if (draft) return (draft.options as unknown as Record<string, unknown>)[key]
      }
      // The editor edits the stored profile, so an explicit profile value wins.
      // Effective values are only the fallback for a field this profile omits.
      // Reading effective first replaced a saved host with the resolver's empty
      // default and rendered the Host input blank.
      const own = (profile.options as unknown as Record<string, unknown>)[key]
      if (own !== undefined && own !== null) return own
      const eff = effField(key)
      if (eff !== undefined) return eff.value
      return undefined
    }

    const isSaved = () => !!profile.id && profiles().some((x) => x.id === profile.id)
    function fvStr(key: string): string {
      const v = fieldValue(key)
      if (typeof v === 'string') return v
      if (typeof v === 'number') return String(v)
      if (typeof v === 'boolean') return v ? 'true' : ''
      return ''
    }

    function fvNum(key: string): number {
      const v = fieldValue(key)
      return v != null && typeof v === 'number' ? v : 0
    }

    function fvBool(key: string): boolean {
      const v = fieldValue(key)
      return v === true
    }

    const jumpOptions = createMemo((): SelectOption[] =>
      jumpServerProfiles().map((p) => ({
        value: p.id,
        label: p.name,
      })),
    )
    const groupOptions = createMemo((): SelectOption[] =>
      groups().map((g) => ({
        value: g.id,
        label: g.name,
      })),
    )

    function fieldRow(field: string, textField: JSX.Element) {
      void field
      return <div class="cm-field-row">{textField}</div>
    }

    return (
      <div class="cm-form">
        <Tabs
          items={[
            {
              id: 'general',
              label: 'General',
              content: () => (
                <Stack>
                  <TextField
                    id="profile-name"
                    label="Name"
                    required
                    value={profile.name}
                    error={profileValidation.error('name')}
                    onInput={onNameChange}
                    onBlur={() => profileValidation.touch('name')}
                  />
                  {fieldRow(
                    'host',
                    <TextField
                      id="profile-host"
                      label="Host"
                      required
                      value={fvStr('host')}
                      error={profileValidation.error('host')}
                      onInput={(v) => setOption('host', v)}
                      onBlur={() => profileValidation.touch('host')}
                    />,
                  )}
                  {fieldRow(
                    'port',
                    <TextField
                      id="profile-port"
                      label="Port"
                      required
                      value={fvNum('port') || 22}
                      type="number"
                      error={profileValidation.error('port')}
                      onInput={(v) => {
                        const n = parseInt(v, 10)
                        setOption('port', isNaN(n) ? 0 : n)
                      }}
                      onBlur={() => profileValidation.touch('port')}
                    />,
                  )}
                  <Show when={isSaved()}>
                    <Field for="profile-group" label="Group">
                      <Select
                        value={profile.group ?? ''}
                        onChange={(v) => {
                          const targetGroupId = v || ''
                          setEditing({ ...profile, group: targetGroupId || undefined })
                          setDirtyFields((prev) => new Set(prev).add('group'))
                          if (profile.id) void computeMoveImpact(profile.id, targetGroupId)
                        }}
                        options={groupOptions()}
                        placeholder="&mdash; No group &mdash;"
                      />
                    </Field>
                  </Show>
                </Stack>
              ),
            },
            {
              id: 'auth',
              label: 'Authentication',
              content: () => (
                <Stack>
                  <AuthenticationEditor
                    id="profile-auth"
                    credentials={credentials()}
                    credentialId={fvStr('credentialId') || undefined}
                    onCredentialChange={(value) => setOption('credentialId', value)}
                    onCreateCredential={openCredDialog}
                    username={fvStr('user')}
                    onUsernameChange={(value) => setOption('user', value)}
                    auth={fvStr('auth') as AuthMode}
                    onAuthChange={(value) => setOption('auth', value)}
                    credentialDraft={profileCredDraft() ?? undefined}
                    onCredentialDraftChange={(draft) => setProfileCredDraft(draft)}
                    passwordAction={
                      <Field for="profile-password-action" label="Password">
                        <div class="credential-secret-action">
                          <span class="credential-secret-description">
                            {profilePasswordValue() ? 'Password ready to save' : 'No password set'}
                          </span>
                          <div class="credential-secret-actions">
                            <Button variant="default" onClick={() => setProfilePasswordOpen(true)}>
                              {profilePasswordValue() ? 'Change Password' : 'Set Password'}
                            </Button>
                          </div>
                        </div>
                      </Field>
                    }
                    publicKeyAction={
                      <Field for="profile-key" label="Private Key">
                        <SegmentedControl
                          options={[
                            { value: 'path', label: 'Path' },
                            { value: 'file', label: 'Choose file' },
                            { value: 'material', label: 'Paste key' },
                          ]}
                          value={profileKeyMode()}
                          onChange={(value) => {
                            const prev = profileKeyMode()
                            if (value === 'material') {
                              handleKeyPathChange(undefined)
                            } else if (prev === 'material') {
                              const credId = fvStr('credentialId')
                              setProfileKeyText('')
                              setProfileKeyFingerprint(undefined)
                              setProfileKeyTextError(undefined)
                              if (!profileCredDraft()) {
                                setOption('credentialId', undefined)
                              }
                              if (credId) {
                                props.client.deleteKeyMaterial(credId).catch((err: unknown) => {
                                  log.error('Failed to delete key material', {
                                    message: (err as Error).message,
                                  })
                                })
                              }
                            }
                            if (value === 'path' || value === 'file') {
                              setProfileKeyText('')
                              setProfileKeyFingerprint(undefined)
                              setProfileKeyTextError(undefined)
                            }
                            setProfileKeyMode(value as KeyInputMode)
                          }}
                          ariaLabel="Key input mode"
                        />
                        <Show when={profileKeyMode() === 'path'}>
                          <TextField
                            id="profile-key-path"
                            label="Private Key Path"
                            value={keyPathValue()}
                            onInput={(value) => handleKeyPathChange(value || undefined)}
                            placeholder="~/.ssh/id_ed25519"
                          />
                        </Show>
                        <Show when={profileKeyMode() === 'file'}>
                          <FileInput
                            accept="*"
                            onChange={(file) => {
                              if (file) {
                                const filePath =
                                  (file as File & { path?: string })?.path ?? file.name
                                handleKeyPathChange(filePath)
                              }
                            }}
                            ariaLabel="Choose private key file"
                            buttonLabel="Choose file…"
                          />
                        </Show>
                        <Show when={profileKeyMode() === 'material'}>
                          <TextField
                            multiline
                            id="profile-key-text"
                            label="Private Key"
                            value={profileKeyText()}
                            onInput={(value) => {
                              setProfileKeyText(value)
                              setProfileKeyTextError(undefined)
                            }}
                            placeholder="Paste the private key content here"
                            error={profileKeyTextError()}
                          />
                          <Show when={profileKeyFingerprint()}>
                            <span class="cm-key-fingerprint">
                              Fingerprint: {profileKeyFingerprint()}
                            </span>
                          </Show>
                        </Show>
                      </Field>
                    }
                  />
                </Stack>
              ),
            },
            {
              id: 'advanced',
              label: 'Advanced',
              content: () => (
                <Stack>
                  {fieldRow(
                    'keepaliveInterval',
                    <TextField
                      id="profile-keepalive-interval"
                      label="Keepalive interval (ms)"
                      value={fvNum('keepaliveInterval')}
                      type="number"
                      min={0}
                      error={profileValidation.error('keepaliveInterval')}
                      onInput={(v) => {
                        const n = parseInt(v, 10)
                        setOption('keepaliveInterval', isNaN(n) ? 0 : n)
                      }}
                      onBlur={() => profileValidation.touch('keepaliveInterval')}
                    />,
                  )}
                  {fieldRow(
                    'keepaliveCountMax',
                    <TextField
                      id="profile-keepalive-count"
                      label="Keepalive count max"
                      value={fvNum('keepaliveCountMax')}
                      type="number"
                      min={0}
                      error={profileValidation.error('keepaliveCountMax')}
                      onInput={(v) => {
                        const n = parseInt(v, 10)
                        setOption('keepaliveCountMax', isNaN(n) ? 0 : n)
                      }}
                      onBlur={() => profileValidation.touch('keepaliveCountMax')}
                    />,
                  )}
                  {fieldRow(
                    'readyTimeout',
                    <TextField
                      id="profile-ready-timeout"
                      label="Ready timeout (ms)"
                      value={fvNum('readyTimeout')}
                      type="number"
                      min={0}
                      error={profileValidation.error('readyTimeout')}
                      onInput={(v) => {
                        const n = parseInt(v, 10)
                        setOption('readyTimeout', isNaN(n) ? 0 : n)
                      }}
                      onBlur={() => profileValidation.touch('readyTimeout')}
                    />,
                  )}
                  <Field for="jump-host" label="Jump server">
                    <div class="cm-field-row">
                      <Select
                        value={fvStr('jumpHost')}
                        onChange={(v) => setOption('jumpHost', v || undefined)}
                        options={jumpOptions()}
                        placeholder="&mdash; None &mdash;"
                      />
                    </div>
                  </Field>
                  <div class="cm-check-group">
                    <Checkbox
                      label="Agent forward"
                      checked={fvBool('agentForward')}
                      onChange={(v) => setOption('agentForward', v)}
                    />
                    <Checkbox
                      label="Can be used as jump server"
                      checked={fvBool('canBeJumpServer')}
                      onChange={(v) => setOption('canBeJumpServer', v)}
                    />
                  </div>
                </Stack>
              ),
            },
          ]}
          active={profileSection()}
          onChange={setProfileSection}
          ariaLabel="Connection sections"
        />

        {/* Pinned under the pane, like the group editor's blast radius: what a
            move does to inherited settings has to be in front of the person
            making it, not filed behind a section they can decline to open. */}
        <Show
          when={
            profileMoveImpact() &&
            ((profileMoveImpact()!.affectedProfiles?.length ?? 0) > 0 ||
              profileMoveImpact()!.dangerous)
          }
        >
          <div class="cm-group-impact">{renderImpactSummary(profileMoveImpact()!)}</div>
        </Show>
      </div>
    )
  }

  // ── Main render ────────────────────────────────────────────────────────

  return (
    <div class="cm-root">
      <CollectionView
        searchValue={searchQuery()}
        onSearch={setSearchQuery}
        searchPlaceholder="Filter connections"
        searchLabel="Filter connections"
        actions={
          <>
            <Button variant="default" onClick={openImportDialog}>
              Import…
            </Button>
            <Button variant="default" onClick={startNewGroup}>
              New group
            </Button>
            <Button variant="primary" onClick={startNewProfile}>
              + New connection
            </Button>
          </>
        }
        hasItems={profiles().length > 0 || groups().length > 0}
        empty={
          <EmptyState
            title="No connections yet"
            description="Add one by hand, or import from ~/.ssh/config, Tabby, or an export."
            action={
              <>
                <Button variant="primary" onClick={startNewProfile}>
                  + New connection
                </Button>
                <Button variant="default" onClick={openImportDialog}>
                  Import…
                </Button>
              </>
            }
          />
        }
      >
        <div role="list" aria-label="Connection list">
          <For each={tree()}>{(node) => renderGroupSection(node)}</For>
          <Show when={ungrouped().length > 0}>
            <div class="cm-group-header" role="heading" aria-level={2}>
              <span class="cm-group-name">{groups().length > 0 ? 'Ungrouped' : 'Connections'}</span>
            </div>
            <For each={ungrouped()}>{(p) => renderRow(p)}</For>
          </Show>
        </div>
        {/* A filter that matches nothing hid every row and every group and
              said nothing, which is indistinguishable from the list failing
              to load. */}
        <Show when={searchQuery().trim() !== '' && filteredProfiles().length === 0}>
          <EmptyState
            title="Nothing matches this filter"
            description={`No connection's name, host or user contains "${searchQuery().trim()}".`}
          />
        </Show>
      </CollectionView>

      {/* Editor Dialog */}
      <Show when={editing()}>
        {(profile) => (
          <Dialog
            open={dialogOpen()}
            onClose={closeDialog}
            title={profile().id ? `Edit Connection: ${profile().name}` : 'New Connection'}
            size="lg"
            onSubmit={() => void saveProfile(profile())}
            footer={
              <>
                <Button variant="primary" onClick={() => void saveProfile(profile())}>
                  {profile().id ? 'Save Connection' : 'Create Connection'}
                </Button>
                <Show when={profile().id}>
                  <Button variant="danger" onClick={() => void deleteProfile(profile())}>
                    Delete Connection
                  </Button>
                </Show>
                <Button variant="default" onClick={closeDialog}>
                  Cancel
                </Button>
              </>
            }
          >
            {renderProfileForm(profile())}
            <PasswordEditor
              open={profilePasswordOpen()}
              value={profilePasswordValue()}
              prompt={`Password for ${
                editing()?.options.user || editing()?.options.host || 'connection'
              }`}
              onClose={() => setProfilePasswordOpen(false)}
              onSave={setProfilePasswordValue}
            />
          </Dialog>
        )}
      </Show>

      {/* Quick-connect Dialog — creation starts from one field */}
      <Dialog
        open={quickConnectOpen()}
        onClose={closeQuickConnect}
        title="New Connection"
        size="lg"
        onSubmit={handleQuickConnect}
        footer={
          <>
            <Button variant="primary" onClick={handleQuickConnect}>
              Next
            </Button>
            <Button variant="default" onClick={closeQuickConnect}>
              Cancel
            </Button>
          </>
        }
      >
        <TextField
          id="quick-connect-input"
          label="Host or connection string"
          value={quickConnectValue()}
          onInput={(v) => setQuickConnectValue(v)}
          placeholder="deploy@host:2222 or ssh://user@host:2222"
        />
        <p class="cm-hint">
          Paste a host, alias, or connection string above. Parsed fields will be filled into the
          form.
        </p>
      </Dialog>

      {/* Import Dialog — bringing connections in from elsewhere */}
      <Dialog
        open={importOpen()}
        onClose={closeImportDialog}
        title="Import Connections"
        size="lg"
        footer={
          <>
            <Button variant="primary" disabled={importBusy()} onClick={() => void runImport()}>
              {importBusy() ? 'Importing…' : importSource() === 'tabby' ? 'Preview' : 'Import'}
            </Button>
            <Button variant="default" disabled={importBusy()} onClick={closeImportDialog}>
              Cancel
            </Button>
          </>
        }
      >
        <Field for="cm-import-source" label="Source">
          <div class="cm-radio-group">
            <For each={IMPORT_SOURCES()}>
              {(src) => (
                <Radio
                  value={src.value}
                  checked={importSource() === src.value}
                  onChange={(v) => {
                    setImportSource(v as ImportSource)
                    // A file chosen for one source is not a file for another.
                    setImportFile(null)
                  }}
                  name="cm-import-source"
                  label={src.label}
                />
              )}
            </For>
          </div>
        </Field>

        {/* The file row is always present, and disabled for the source that
            takes no file. Showing it conditionally made the dialog change
            height under the pointer as the user moved down the radio list —
            the buttons they were reaching for moved away from them. Keyed on
            the source so switching between the two file sources remounts the
            picker: FileInput holds the chosen name internally and would
            otherwise still display a file we have just discarded. */}
        <Show when={importSource()} keyed>
          {(src) => (
            <Field for="cm-import-file" label="File">
              <FileInput
                id="cm-import-file"
                accept={src === 'tabby' ? '.yml,.yaml' : '.json'}
                disabled={importBusy() || src === 'sshConfig'}
                onChange={setImportFile}
              />
            </Field>
          )}
        </Show>

        {/* Passphrase field for encrypted Tabby vaults. */}
        <Show when={importSource() === 'tabby'}>
          <Field for="cm-import-passphrase" label="Vault passphrase (if encrypted)">
            <TextField
              id="cm-import-passphrase"
              type="password"
              value={importPassphrase()}
              onInput={(v) => setImportPassphrase(v)}
              placeholder="Leave blank unless the Tabby vault is encrypted"
            />
          </Field>
        </Show>

        <p class="cm-hint cm-import-hint">{importHint()}</p>
      </Dialog>

      {/* Tabby Import Preview Dialog */}
      <Show when={previewOpen() && previewResult()}>
        {(preview) => (
          <Dialog
            open={previewOpen()}
            onClose={closePreview}
            title="Tabby Import Preview"
            size="lg"
            footer={
              <>
                <Button
                  variant="primary"
                  disabled={importBusy()}
                  onClick={() => void executeImport()}
                >
                  {importBusy() ? 'Importing…' : 'Import'}
                </Button>
                <Button variant="default" onClick={closePreview}>
                  Cancel
                </Button>
              </>
            }
          >
            <Stack gap="default">
              <p>
                The Tabby configuration contains <strong>{preview().profilesToImport}</strong>{' '}
                {preview().profilesToImport === 1 ? 'profile' : 'profiles'},{' '}
                <strong>{preview().groupsToImport}</strong>{' '}
                {preview().groupsToImport === 1 ? 'group' : 'groups'}, and{' '}
                <strong>{preview().credentialsToImport}</strong>{' '}
                {preview().credentialsToImport === 1 ? 'credential' : 'credentials'}.
              </p>

              <Show when={preview().profileEntries && preview().profileEntries!.length > 0}>
                <p>
                  <strong>Profiles</strong>
                </p>
                <For each={preview().profileEntries || []}>
                  {(entry) => (
                    <p>
                      {entry.name} —{' '}
                      {entry.action === 'new'
                        ? 'new'
                        : entry.action === 'overwrite'
                          ? 'will overwrite existing'
                          : 'needs review'}
                    </p>
                  )}
                </For>
              </Show>

              <Show when={preview().groupNames && preview().groupNames!.length > 0}>
                <p>
                  <strong>Groups</strong>
                </p>
                <For each={preview().groupNames || []}>{(name) => <p>{name}</p>}</For>
              </Show>

              <Show when={preview().credentialEntries && preview().credentialEntries!.length > 0}>
                <p>
                  <strong>Credentials</strong>
                </p>
                <For each={preview().credentialEntries || []}>
                  {(entry) => (
                    <p>
                      {entry.name} ({entry.type})
                    </p>
                  )}
                </For>
              </Show>

              <Show when={preview().collisions && preview().collisions!.length > 0}>
                <p>
                  <strong>Collisions</strong>
                </p>
                <For each={preview().collisions || []}>
                  {(c) => (
                    <p>
                      {c.kind} "{c.name}" —{' '}
                      {c.policy === 'overwrite'
                        ? 'will be overwritten'
                        : c.policy === 'refuse'
                          ? 'import refused (already exists)'
                          : 'needs review'}
                    </p>
                  )}
                </For>
              </Show>

              <Show when={preview().skippedSecrets && preview().skippedSecrets!.length > 0}>
                <p>
                  <strong>Skipped secrets</strong>
                </p>
                <For each={preview().skippedSecrets || []}>
                  {(s) => (
                    <p>
                      {s.secretType}: {s.reason}
                    </p>
                  )}
                </For>
              </Show>

              <p>
                <strong>Destination:</strong> {preview().secretProvider}
              </p>
            </Stack>
          </Dialog>
        )}
      </Show>

      {/* Credential creation Dialog (from within connection form) */}
      <Show when={credDraft()}>
        {(cred) => (
          <Dialog
            open={credDialogOpen()}
            onClose={closeCredDialog}
            title="New Credential"
            size="lg"
            onSubmit={() => void handleCredSave()}
            footer={
              <>
                <Button variant="primary" onClick={() => void handleCredSave()}>
                  Save Credential
                </Button>
                <Button variant="default" onClick={closeCredDialog}>
                  Cancel
                </Button>
              </>
            }
          >
            <CredentialForm
              credential={cred()}
              onFieldChange={(key, value) => {
                setCredDraft({ ...cred(), [key]: value })
              }}
              passwordValue={credPasswordValue()}
              onPasswordChange={setCredPasswordValue}
              ref={credFormRef}
            />
          </Dialog>
        )}
      </Show>

      {/* Group Editor Dialog */}
      <Show when={editingGroup()}>
        {(group) => (
          <Dialog
            open={groupDialogOpen()}
            onClose={closeGroupEditor}
            // The live draft name, not the stored one: the title is where the
            // group's identity stays readable once the user is two sections
            // deep in defaults, and a title showing the old name while the
            // General field shows a new one is worse than no title at all.
            title={
              group().id
                ? `Edit Group: ${groupDraft()?.name || group().name}`
                : groupDraft()?.name
                  ? `New Group: ${groupDraft()!.name}`
                  : 'New Group'
            }
            size="lg"
            onSubmit={() => void saveGroup()}
            footer={
              <>
                <Button
                  variant={groupImpact()?.dangerous ? 'danger' : 'primary'}
                  disabled={groupApplyBusy() || (groupImpact()?.dangerous && !dangerConfirmed())}
                  onClick={() => void saveGroup()}
                >
                  {groupApplyBusy() ? 'Applying…' : group().id ? 'Save Group' : 'Create Group'}
                </Button>
                <Button variant="default" onClick={closeGroupEditor} disabled={groupApplyBusy()}>
                  Cancel
                </Button>
              </>
            }
          >
            {renderGroupEditor()}
          </Dialog>
        )}
      </Show>

      {/* Group Delete Confirmation Dialog */}
      <Show when={deleteConfirmOpen()}>
        <Dialog
          open={deleteConfirmOpen()}
          onClose={cancelDeleteGroup}
          // Which group. A confirmation that does not name what it is about to
          // destroy is asking the user to remember which row they clicked.
          title={deleteGroupName() ? `Delete Group: ${deleteGroupName()}` : 'Delete Group'}
          footer={
            <>
              <Button
                variant="danger"
                disabled={deleteBusy() || deleteImpact()?.deleteImpact?.action === 'refuse'}
                onClick={() => void executeDeleteGroup()}
              >
                {deleteBusy()
                  ? 'Deleting…'
                  : deleteImpact()?.deleteImpact?.action === 'refuse'
                    ? 'Cannot Delete'
                    : 'Delete Group'}
              </Button>
              {/* autofocus on Cancel, deliberately. A native showModal()
                  focuses the first focusable descendant, and this dialog's
                  body is text — so focus landed on "Delete Group" and one
                  Enter, pressed by someone who was still typing a moment ago,
                  destroyed the group. The safe action takes the focus; the
                  destructive one has to be aimed at. */}
              <Button
                variant="default"
                onClick={cancelDeleteGroup}
                disabled={deleteBusy()}
                autofocus
              >
                Cancel
              </Button>
            </>
          }
        >
          <Show when={deleteBusy() && !deleteImpact()}>
            <p>Computing impact…</p>
          </Show>
          <Show when={deleteImpact()?.deleteImpact} keyed>
            {(di) => (
              <div class="cm-delete-impact">
                <Show when={di.action === 'refuse'}>
                  <div class="cm-impact-danger-badge" role="alert">
                    {di.reason}
                  </div>
                  <p>This group cannot be deleted through this dialog.</p>
                </Show>
                <Show when={di.action === 'promote_to_root'}>
                  {/* The written sentence first, the backend's rationale after
                      it. "group has no children" is why the backend chose this
                      action, not what the user is agreeing to. */}
                  <p>
                    Delete the group <strong>{deleteGroupName()}</strong>? Its connections and
                    subgroups move to the top level; nothing is deleted with it.
                  </p>
                  <p class="cm-delete-reason">{di.reason}</p>
                  <Show
                    when={
                      deleteImpact()?.affectedProfiles &&
                      deleteImpact()!.affectedProfiles!.length > 0
                    }
                  >
                    <Section title="Affected Connections">
                      {renderImpactSummary(deleteImpact()!)}
                    </Section>
                  </Show>
                </Show>
              </div>
            )}
          </Show>
        </Dialog>
      </Show>
    </div>
  )
}
