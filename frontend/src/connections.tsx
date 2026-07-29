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
import { Toolbar } from './ui/toolbar'
import { Dialog, showConfirm } from './ui/dialog'
import { Section } from './ui/section'
import { Radio } from './ui/radio'
import { EmptyState } from './ui/empty-state'
import { Field } from './ui/field'
import { Badge } from './ui/badge'
import { IconButton } from './ui/icon-button'
import { SearchField } from './ui/search-field'
import { PlugIcon, ResetIcon } from './ui/icons'
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
} from './profiles'
import { ProfileClient, buildGroupTree } from './profiles'
import { log } from './log'
import { showToast } from './ui/toast'

// ── Helpers ─────────────────────────────────────────────────────────────────

function authModeLabel(mode: AuthMode): string {
  switch (mode) {
    case '':
      return 'Auto'
    case 'password':
      return 'Password'
    case 'publicKey':
      return 'Public Key'
    case 'agent':
      return 'Agent'
    case 'keyboardInteractive':
      return 'Keyboard Interactive'
  }
}

const AUTH_MODES: AuthMode[] = ['', 'password', 'publicKey', 'agent', 'keyboardInteractive']

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

function probeOutcomeTone(outcome: ProbeOutcome): 'neutral' | 'info' | 'warning' | 'danger' {
  switch (outcome) {
    case 'accepted':
      return 'info'
    case 'rejected':
      return 'danger'
    case 'unreachable':
      return 'warning'
    case 'host-key-problem':
      return 'danger'
    case 'needs-interactive':
      return 'warning'
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

  const nonPatchable: Record<string, true> = { name: true, host: true }
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

// ── Props ────────────────────────────────────────────────────────────────────

export interface ConnectionsViewProps {
  client: ProfileClient
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
   * Navigate to the Credentials settings section, typically by
   * setting the active settings page to 'credentials'.
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

  // ── Effective/provenance state ─────────────────────────────────────────
  const [effectiveData, setEffectiveData] = createSignal<Record<string, EffectiveProfileDTO>>({})
  const [dirtyFields, setDirtyFields] = createSignal<Set<string>>(new Set())

  // ── Session state per profile ──────────────────────────────────────────
  const [sessionStatuses, setSessionStatuses] = createSignal<Record<string, SessionStatus>>({})

  // ── Probe result per profile ──────────────────────────────────────────
  const [probeResults, setProbeResults] = createSignal<
    Record<string, { outcome: ProbeOutcome; detail?: string } | null>
  >({})
  const [probeBusy, setProbeBusy] = createSignal<Set<string>>(new Set())

  // ── Filter ─────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = createSignal('')

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
      setProbeResults((prev) => ({ ...prev, [profile.id]: res }))
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
    const profile: SSHProfile = {
      id: '',
      type: 'ssh',
      name: 'New connection',
      options: { host: '', port: 22, user: '', auth: '' },
    }
    setEditing(profile)
    setDirtyFields(new Set<string>())
    profileValidation.reset()
    setDialogOpen(true)
  }

  function openEditDialog(profile: SSHProfile) {
    setEditing(profile)
    setDirtyFields(new Set<string>())
    profileValidation.reset()
    void loadEffective([profile.id])
    setDialogOpen(true)
  }

  function closeDialog() {
    setDialogOpen(false)
    setEditing(null)
    setDirtyFields(new Set<string>())
  }

  // ── Validation ──────────────────────────────────────────────────────────

  const formProfile = createMemo<SSHProfile | null>(() => {
    return editing()
  })

  const profileValidation = createFormValidation({
    name: () => required('Name')(formProfile()?.name ?? ''),
    host: () => combine(required('Host'), hostname())(formProfile()?.options.host ?? ''),
    port: () => combine(required('Port'), portRule())(String(formProfile()?.options.port ?? '')),
    user: () => {
      const p = formProfile()
      if (!p || p.options.credentialId) return undefined
      return required('User')(p.options.user ?? '')
    },
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

    const dirty = dirtyFields()
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

  function connectFromForm(profile: SSHProfile) {
    if (!gate(profileValidation)) return
    closeDialog()
    props.onConnect?.(profile)
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

  async function revertField(field: string) {
    const p = formProfile()
    if (!p || !p.id) return
    try {
      const eff = await props.client.patchProfile({ id: p.id, unset: [`options.${field}`] })
      setEffectiveData((prev) => ({ ...prev, [p.id]: eff }))
      setDirtyFields((prev: Set<string>) => {
        const next = new Set(prev)
        next.delete(field)
        return next
      })
      // Drop the field from the draft rather than writing the inherited value
      // into it. Two reasons, and the second is the whole point of revert.
      //
      // Display does not need it: fieldValue() falls through to the effective
      // entry once the field is no longer dirty.
      //
      // Saving must not have it. A later edit to the name or host routes through
      // profiles.update, which writes the WHOLE profile — so an inherited value
      // sitting in options would be persisted as an explicit override, and the
      // field just reverted would be pinned to the value it used to inherit.
      // Spec §3.3's first binding rule: an inherited value is never
      // materialised, because once it is, "inherited 2222" and "overridden here
      // to 2222" are the same state forever.
      const updated = { ...p, options: { ...p.options } }
      delete (updated.options as unknown as Record<string, unknown>)[field]
      setEditing(updated)
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to revert field', { field, message })
      showToast({ level: 'danger', message: `Could not revert "${field}": ${message}` })
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
    const probe = () => probeResults()[p.id]
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
      <div class="cm-item" role="listitem" tabIndex={-1}>
        <div class="cm-item-info">
          <div class="cm-item-name">{p.name}</div>
          <div class="cm-item-meta">
            <Badge tone="neutral">{p.type.toUpperCase()}</Badge>
            <span class="cm-item-address">
              {p.options.user || '?'}@{p.options.host}:{p.options.port || 22}
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
          {/* Probe result — only shown when present */}
          <Show when={probe()} keyed>
            {(pr) => (
              <>
                <Badge tone={probeOutcomeTone(pr.outcome)}>{probeOutcomeLabel(pr.outcome)}</Badge>
                <Show when={pr.detail} keyed>
                  {(detail) => <span class="cm-probe-detail">{detail}</span>}
                </Show>
              </>
            )}
          </Show>
        </div>
        <div class="cm-item-actions">
          <Button
            variant="default"
            size="sm"
            disabled={isTesting()}
            onClick={() => void handleTest(p)}
            ariaLabel={`Test connection to ${p.name}`}
          >
            {isTesting() ? 'Testing...' : 'Test'}
          </Button>
          <IconButton
            size="sm"
            title="Connect"
            ariaLabel={`Connect to ${p.name}`}
            onClick={() => props.onConnect?.(p)}
          >
            <PlugIcon />
          </IconButton>
          <Button
            variant="default"
            size="sm"
            onClick={() => openEditDialog(p)}
            ariaLabel={`Edit ${p.name}`}
          >
            Edit
          </Button>
        </div>
      </div>
    )
  }

  function renderGroupSection(node: TreeNode) {
    const gp = groupProfiles(node.id)
    if (gp.length === 0 && node.children.length === 0) return null
    return (
      <>
        <div class="cm-group-header" role="heading" aria-level={2}>
          {node.name}
        </div>
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

    function effField(field: string): EffectiveFieldDTO | undefined {
      const eff = effectiveData()[profile.id]
      return eff?.fields[field]
    }

    function provenanceBadge(field: string) {
      if (dirtyFields().has(field)) {
        return (
          <span class="cm-provenance">
            <span class="cm-provenance-label cm-provenance-overridden">overridden here</span>
            <IconButton
              size="sm"
              ariaLabel={`Revert ${field}`}
              title="Revert to inherited"
              onClick={(e: MouseEvent) => {
                e.preventDefault()
                void revertField(field)
              }}
            >
              <ResetIcon />
            </IconButton>
          </span>
        )
      }
      const eff = effField(field)
      if (!eff) return null

      const label = sourceLabel(eff.source)
      if (eff.source.kind === 'credential') {
        return (
          <span class="cm-provenance">
            <Button
              variant="ghost"
              onClick={() => props.onNavigateToCredentials?.()}
              title="Open Credentials settings"
            >
              {label}
            </Button>
          </span>
        )
      }
      return (
        <span class="cm-provenance">
          <span class="cm-provenance-label">{label}</span>
        </span>
      )
    }

    function fieldValue(key: string): unknown {
      const dirty = dirtyFields()
      if (dirty.has(key)) {
        const draft = editing()
        if (draft) return (draft.options as unknown as Record<string, unknown>)[key]
      }
      const eff = effField(key)
      if (eff !== undefined) return eff.value
      return (profile.options as unknown as Record<string, unknown>)[key]
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

    const credOptions = createMemo((): SelectOption[] =>
      credentials().map((c) => ({
        value: c.id,
        label: `${c.name} (${c.username})`,
      })),
    )

    const jumpOptions = createMemo((): SelectOption[] =>
      jumpServerProfiles().map((p) => ({
        value: p.id,
        label: p.name,
      })),
    )

    function fieldRow(field: string, textField: JSX.Element) {
      const isSaved = !!profile.id && profiles().some((x) => x.id === profile.id)
      return (
        <div class="cm-field-row">
          {textField}
          {isSaved && provenanceBadge(field)}
        </div>
      )
    }

    const effCredId = fvStr('credentialId')
    const hasCredential = !!effCredId
    const credObj = credentials().find((c) => c.id === effCredId)

    return (
      <div class="cm-form">
        <Section title="Basic">
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

          <Field for="credential-select" label="Credential">
            <div class="cm-field-row">
              <Select
                value={fvStr('credentialId')}
                onChange={(v) => setOption('credentialId', v || undefined)}
                options={credOptions()}
                placeholder="&mdash; None (specify below) &mdash;"
              />
              {isSaved() && provenanceBadge('credentialId')}
            </div>
          </Field>

          <Show when={!hasCredential}>
            {fieldRow(
              'user',
              <TextField
                id="profile-user"
                label="User"
                required
                value={fvStr('user')}
                error={profileValidation.error('user')}
                onInput={(v) => setOption('user', v)}
                onBlur={() => profileValidation.touch('user')}
              />,
            )}
          </Show>
        </Section>

        <Show when={!hasCredential}>
          <Section title="Authentication (override)">
            <div class="cm-tip">
              Tip: Create a Credential above to reuse auth settings across connections.
            </div>
            <Field for="auth-method" label="Method">
              <div class="cm-radio-group">
                <For each={AUTH_MODES}>
                  {(mode) => (
                    <Radio
                      value={mode}
                      checked={fvStr('auth') === mode}
                      onChange={(v) => setOption('auth', v)}
                      name="auth-mode"
                      label={authModeLabel(mode)}
                    />
                  )}
                </For>
              </div>
            </Field>
            {isSaved() && provenanceBadge('auth')}
          </Section>
        </Show>

        <Show when={hasCredential}>
          <div class="cm-form-section">
            <div class="cm-credential-card">
              <strong>Using Credential: </strong>
              <span>{credObj ? credObj.name : 'Unknown'}</span>
              <br />
              <small>
                {credObj
                  ? `Username: ${credObj.username} | Auth: ${authModeLabel(credObj.auth)}`
                  : ''}
              </small>
            </div>
          </div>
        </Show>

        <Section title="Advanced">
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
              {isSaved() && provenanceBadge('jumpHost')}
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
          {isSaved() && (provenanceBadge('agentForward') || provenanceBadge('canBeJumpServer'))}
        </Section>
      </div>
    )
  }

  // ── Main render ────────────────────────────────────────────────────────

  return (
    <div class="cm-root">
      <Toolbar>
        <div class="cm-search">
          <SearchField
            value={searchQuery()}
            onInput={setSearchQuery}
            placeholder="Filter connections"
            ariaLabel="Filter connections"
          />
        </div>
        <Button variant="primary" onClick={startNewProfile}>
          + New connection
        </Button>
      </Toolbar>
      <Show
        when={profiles().length > 0}
        fallback={
          <EmptyState
            title="No connections yet"
            description={'Click "+ New connection" to add one.'}
          />
        }
      >
        <div class="cm-body" role="list" aria-label="Connection list">
          <For each={tree()}>{(node) => renderGroupSection(node)}</For>
          <Show when={ungrouped().length > 0}>
            <div class="cm-group-header" role="heading" aria-level={2}>
              Connections
            </div>
            <For each={ungrouped()}>{(p) => renderRow(p)}</For>
          </Show>
        </div>
      </Show>

      {/* Editor Dialog */}
      <Show when={editing()}>
        {(profile) => (
          <Dialog
            open={dialogOpen()}
            onClose={closeDialog}
            title={profile().id ? `Edit Connection: ${profile().name}` : 'New Connection'}
            footer={
              <>
                <Button variant="primary" onClick={() => void saveProfile(profile())}>
                  {profile().id ? 'Save Connection' : 'Create Connection'}
                </Button>
                <Button variant="default" onClick={() => connectFromForm(profile())}>
                  Connect
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
          </Dialog>
        )}
      </Show>
    </div>
  )
}
