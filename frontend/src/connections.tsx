/**
 * ConnectionsView — Solid component for the connections manager.
 *
 * Replaces the imperative ConnectionManagerViewImpl (deleted in the same
 * commit). Uses the UI kit (Button, TextField, Checkbox, Select, Toolbar)
 * and Solid reactive state instead of hand-rolled DOM and private fields.
 *
 * Behaviour that must match the predecessor:
 * - Header with title and action buttons
 * - Profile list on the left, form panel on the right
 * - Grouped profile display using buildGroupTree
 * - Full SSH profile editing including credential selector, auth radio,
 *   advanced settings, jump host selector
 * - Credential CRUD with host-binding validation
 * - Quick connect via dblclick or the row's connect button
 * - Import from Tabby
 * - onConnect callback
 */
import { For, Show, createSignal, createMemo, createEffect, on, onMount, type JSX } from 'solid-js'
import { Button } from './ui/button'
import { TextField } from './ui/text-field'
import { Checkbox } from './ui/checkbox'
import { Select, type SelectOption } from './ui/select'
import { Toolbar } from './ui/toolbar'
import { showConfirm } from './ui/dialog'
import { Section } from './ui/section'
import { Radio } from './ui/radio'
import { EmptyState } from './ui/empty-state'
import { Field } from './ui/field'
import { Badge } from './ui/badge'
import { IconButton } from './ui/icon-button'
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

  // ── Selection state ─────────────────────────────────────────────────────
  const [selectedID, setSelectedID] = createSignal('')
  const [editing, setEditing] = createSignal<SSHProfile | null>(null)

  // ── Effective/provenance state ─────────────────────────────────────────
  const [effectiveData, setEffectiveData] = createSignal<Record<string, EffectiveProfileDTO>>({})
  const [dirtyFields, setDirtyFields] = createSignal<Set<string>>(new Set())

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
      // Current state is kept — a failed refresh must not blank a list the user
      // is reading — but it is no longer kept quietly. Sticky, because the list
      // on screen is now stale and nothing else on it says so.
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

  // Initial load on mount.
  onMount(() => {
    void loadAll()
  })

  // The palette's "New connection" request. Not deferred: a page that mounts
  // with a request already counted is the case where Settings was closed when
  // the user picked it, and deferring would swallow exactly that one.
  createEffect(
    on(
      () => props.newProfileRequest ?? 0,
      (n) => {
        if (n > 0) startNewProfile()
      },
    ),
  )

  /**
   * The profile the form is currently showing.
   *
   * There are two ways a profile reaches the form and only one of them is
   * `editing()`: a draft being typed, and a saved profile picked out of the
   * list, which sets `selectedID` and deliberately clears `editing` so the
   * record on screen is the stored one rather than a copy. `formPanelContent`
   * has always known that. The validation rules did not — they read `editing()`,
   * so in the second case every rule saw `''`.
   *
   * The visible result was a form full of correct values reporting that its
   * fields were required, and a Connect button that did nothing: `gate()` asks
   * the rules, the rules were reading a null draft, and the click was refused
   * with "Name is required" on a field containing a name. It appeared right
   * after saving — `saveProfile` ends in `setEditing(null)` — which made it look
   * like the save had failed when the save was the one thing that worked
   * (nocx-vjhz).
   *
   * One memo, read by the rules and by the panel, so the two cannot drift apart
   * again.
   */
  const formProfile = createMemo<SSHProfile | null>(() => {
    const ed = editing()
    if (ed) return ed
    const selId = selectedID()
    if (!selId) return null
    return profiles().find((x) => x.id === selId) ?? null
  })

  // ── Validation ──────────────────────────────────────────────────────────
  //
  // At component scope, NOT inside renderProfileForm. That function runs inside a
  // createMemo on `editing()`, so it re-runs on every keystroke — signals created
  // there would be thrown away and rebuilt each time, and "this field has been
  // answered" would reset itself as the user typed.
  //
  // The rules read `formProfile()` directly rather than taking the draft as an
  // argument, which is what lets the same object be read by the form (to render
  // the message) and by the submit handlers (to refuse).

  const profileValidation = createFormValidation({
    name: () => required('Name')(formProfile()?.name ?? ''),
    host: () => combine(required('Host'), hostname())(formProfile()?.options.host ?? ''),
    port: () => combine(required('Port'), portRule())(String(formProfile()?.options.port ?? '')),
    // Only when no credential is selected: a credential carries its own username,
    // and the User field is not even rendered in that case.
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

  /**
   * Refuse a submit whose form does not pass, and say why.
   *
   * Reveals every failing field (so the form marks them, not just the first) and
   * raises the first message as a warning toast — because the offending field may
   * be scrolled out of sight in a form this long, and a button that silently does
   * nothing is indistinguishable from one that is broken.
   */
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

  // ── Derived ─────────────────────────────────────────────────────────────
  const jumpServerProfiles = createMemo(() => profiles().filter((p) => p.options.canBeJumpServer))

  const isNewProfile = createMemo(() => {
    const p = editing()
    return p !== null && (!p.id || !profiles().some((x) => x.id === p.id))
  })

  // Every entry point that swaps the record under a form resets that form's
  // validation. Without it the "already answered" marks carry over to the next
  // record and a freshly opened blank form opens with errors already showing.
  function handleProfileClick(p: SSHProfile) {
    setSelectedID(p.id)
    setEditing(null)
    setDirtyFields(new Set<string>())
    profileValidation.reset()
    void loadEffective([p.id])
  }

  function handleProfileDblClick(p: SSHProfile) {
    props.onConnect?.(p)
  }

  function handleQuickConnect(p: SSHProfile) {
    props.onConnect?.(p)
  }

  function startNewProfile() {
    const profile: SSHProfile = {
      id: '',
      type: 'ssh',
      name: 'New connection',
      options: { host: '', port: 22, user: '', auth: '' },
    }
    setSelectedID('')
    setEditing(profile)
    setDirtyFields(new Set<string>())
    profileValidation.reset()
  }
  async function saveProfile(profile: SSHProfile) {
    if (!gate(profileValidation)) return

    const isNew = !profile.id || !profiles().some((x) => x.id === profile.id)

    if (isNew) {
      // New profile: create via full-profile RPC.
      // The backend mints the ID; don't assign one client-side.
      try {
        const saved = await props.client.createProfile(profile)
        setSelectedID(saved.id)
        setEditing(null)
        setDirtyFields(new Set<string>())
        profileValidation.reset()
        await loadAll()
        showToast({ level: 'success', message: `Saved "${saved.name}"` })
      } catch (err) {
        const message = (err as Error).message
        log.error('Failed to save', { message })
        showToast({ level: 'danger', message: `Could not save the connection: ${message}` })
      }
      return
    }

    // Existing profile: decide route based on dirty fields.
    const dirty = dirtyFields()
    const route = decideSaveRoute(profile, dirty)

    switch (route.kind) {
      case 'noop':
        setEditing(null)
        setDirtyFields(new Set<string>())
        return

      case 'update':
        try {
          const saved = await props.client.updateProfile(profile)
          setSelectedID(saved.id)
          setEditing(null)
          setDirtyFields(new Set<string>())
          profileValidation.reset()
          // Refresh both the profiles list (so saved name/host appear) and
          // effective data. loadAll fetches fresh profile/group/credential
          // lists from the backend; loadEffective refreshes the inline
          // provenance state for the updated profile.
          await loadAll()
          await loadEffective([saved.id])
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
          setSelectedID(profile.id)
          setEditing(null)
          setDirtyFields(new Set<string>())
          profileValidation.reset()
          showToast({ level: 'success', message: `Saved "${profile.name}"` })
        } catch (err) {
          const message = (err as Error).message
          log.error('Failed to save', { message })
          showToast({ level: 'danger', message: `Could not save the connection: ${message}` })
        }
        return
    }
  }

  /**
   * Connect from the form. Gated on the same rules as save, because the failure
   * it prevents is the one the user actually hit: a profile with an empty host
   * connects, fails in the backend, and reports it as a connection error rather
   * than as a form that was never filled in.
   */
  function connectFromForm(profile: SSHProfile) {
    if (!gate(profileValidation)) return
    props.onConnect?.(profile)
  }

  async function revertField(field: string) {
    const p = formProfile()
    if (!p || !p.id) return
    try {
      // If the field is still dirty (hasn't been committed yet), unset it
      // on the backend via patch.
      const eff = await props.client.patchProfile({ id: p.id, unset: [`options.${field}`] })
      // Update effective data from the patch response.
      setEffectiveData((prev) => ({ ...prev, [p.id]: eff }))
      // Remove from dirty set.
      setDirtyFields((prev: Set<string>) => {
        const next = new Set(prev)
        next.delete(field)
        return next
      })
      // Drop the field from the draft rather than writing the inherited value
      // into it. Two reasons, and the second one is the whole point of revert.
      //
      // Display does not need it: fieldValue() already falls through to the
      // effective entry once the field is no longer dirty.
      //
      // Saving must not have it. A later edit to the name or host routes through
      // profiles.update, which writes the WHOLE profile — so an inherited value
      // sitting in options would be persisted as an explicit override, and the
      // field the user just reverted would be pinned to the value it used to
      // inherit. Spec §3.3's first binding rule: an inherited value is never
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

  async function deleteProfile(profile: SSHProfile) {
    if (!(await showConfirm(`Delete "${profile.name}"?`))) return
    try {
      await props.client.deleteProfile(profile.id)
      setSelectedID('')
      setEditing(null)
      await loadAll()
      showToast({ level: 'success', message: `Deleted "${profile.name}"` })
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to delete profile', { message })
      // A delete that fails silently is the worst kind: the user confirmed a
      // destructive action, saw nothing happen, and has no way to tell whether
      // it went through.
      showToast({ level: 'danger', message: `Could not delete "${profile.name}": ${message}` })
    }
  }

  function handleImport() {
    const client = props.client
    const doImport = (text: string) => {
      /* eslint-disable solid/reactivity */
      client
        .importTabby(text)
        .then((count) => {
          log.info('Imported SSH profiles from Tabby config', { count })
          void loadAll()
          showToast({
            level: 'success',
            message: `Imported ${count} connections from the Tabby config`,
          })
        })
        .catch((err: unknown) => {
          const message = (err as Error).message
          log.error('Import failed', { message })
          showToast({ level: 'danger', message: `Tabby import failed: ${message}` })
        })
      /* eslint-enable solid/reactivity */
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.yml,.yaml'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      void file.text().then(doImport)
    })
    input.click()
  }
  // ── Render helpers ──────────────────────────────────────────────────────

  function renderGroupSection(node: TreeNode) {
    const groupProfiles = profiles().filter((p) => p.group === node.id)
    return (
      <>
        <div class="cm-group-header">{node.name}</div>
        <For each={groupProfiles}>{(p) => renderListItem(p)}</For>
        <For each={node.children}>{(child) => renderGroupSection(child)}</For>
      </>
    )
  }

  function renderListItem(p: SSHProfile) {
    const isSelected = p.id === selectedID()
    return (
      <div
        classList={{ 'cm-item': true, 'cm-selected': isSelected }}
        onClick={() => handleProfileClick(p)}
        onDblClick={() => handleProfileDblClick(p)}
      >
        <div class="cm-item-info">
          <div class="cm-item-name">{p.name}</div>
          <div class="cm-item-meta">
            {/* The protocol, stated rather than assumed. Every saved profile is
                SSH today, so this reads as redundant — until the second kind
                lands, at which point a list that never said which was which is
                a list nobody can read. A quiet neutral badge for exactly that
                reason: it carries no information yet and must not look as
                though it does.

                Read off `Base.type`, which the backend already sets and
                `startNewProfile` already writes — not a literal. A hard-coded
                "SSH" would keep rendering SSH beside the first profile that is
                not one, and would do it silently (nocx-fmoz). */}
            <Badge tone="neutral">{p.type.toUpperCase()}</Badge>
            <span class="cm-item-address">
              {p.options.user || '?'}@{p.options.host}:{p.options.port || 22}
            </span>
          </div>
        </div>
        <div class="cm-item-actions" onClick={(e) => e.stopPropagation()}>
          {/* An icon, not the word "SSH". The label named a protocol and the
              button performed an action, so one control was doing both jobs and
              reading as neither — it looked like a type tag you could somehow
              press. The two are separate things now: the badge above says what
              this is, this says what it does (nocx-fmoz). */}
          <IconButton
            size="sm"
            title="Connect"
            ariaLabel={`Connect to ${p.name}`}
            onClick={() => handleQuickConnect(p)}
          >
            <PlugIcon />
          </IconButton>
        </div>
      </div>
    )
  }

  function renderEmpty() {
    return (
      <EmptyState
        title="Select a connection to edit"
        description={'Click "+ New connection" to create one.'}
      />
    )
  }

  // ── Profile form ────────────────────────────────────────────────────────

  function renderProfileForm(profile: SSHProfile) {
    const isNew = isNewProfile()
    const isSaved = !!profile.id && profiles().some((x) => x.id === profile.id)

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

    // ── Provenance helpers ──────────────────────────────────────────────
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
                placeholder="— None (specify below) —"
              />
              {isSaved && provenanceBadge('credentialId')}
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
            {isSaved && provenanceBadge('auth')}
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
                placeholder="— None —"
              />
              {isSaved && provenanceBadge('jumpHost')}
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
          {isSaved && (provenanceBadge('agentForward') || provenanceBadge('canBeJumpServer'))}
        </Section>

        <div class="cm-form-actions">
          <Button variant="primary" onClick={() => void saveProfile(profile)}>
            {isNew ? 'Create' : 'Save'}
          </Button>
          <Button variant="default" onClick={() => connectFromForm(profile)}>
            Connect
          </Button>
          <Show when={!isNew}>
            <Button variant="danger" onClick={() => void deleteProfile(profile)}>
              Delete
            </Button>
          </Show>
        </div>
      </div>
    )
  }

  // ── Form panel ─────────────────────────────────────────────────────────

  const formPanelContent = createMemo(() => {
    const p = formProfile()
    if (p) return renderProfileForm(p)

    return renderEmpty()
  })

  // ── Main render ────────────────────────────────────────────────────────

  const tree = createMemo(() => buildGroupTree(groups()))
  const ungrouped = createMemo(() =>
    profiles().filter((p) => !p.group || !groups().some((g) => g.id === p.group)),
  )

  return (
    <div class="cm-root">
      <Toolbar>
        <Button
          variant="default"
          onClick={handleImport}
          title="Import SSH profiles from a Tabby config.yml"
        >
          Import from Tabby
        </Button>

        <Button variant="primary" onClick={startNewProfile}>
          + New connection
        </Button>
      </Toolbar>
      <div class="cm-body">
        <div class="cm-list">
          <Show
            when={profiles().length > 0}
            fallback={
              <EmptyState
                title="No connections yet"
                description={'Click "+ New connection" to add one.'}
              />
            }
          >
            <For each={tree()}>{(node) => renderGroupSection(node)}</For>
            <Show when={ungrouped().length > 0}>
              <div class="cm-group-header">Connections</div>
              <For each={ungrouped()}>{(p) => renderListItem(p)}</For>
            </Show>
          </Show>
        </div>
        <div class="cm-form-panel">{formPanelContent()}</div>
      </div>
    </div>
  )
}
