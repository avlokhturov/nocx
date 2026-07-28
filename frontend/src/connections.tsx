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
import { For, Show, createSignal, createMemo, createEffect, on, onMount } from 'solid-js'
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
import { PlugIcon } from './ui/icons'
import { showToast } from './ui/toast'
import {
  createFormValidation,
  required,
  hostname,
  port as portRule,
  nonNegativeInteger,
  combine,
} from './ui/validation'
import type { SSHProfile, ProfileGroup, Credential, AuthMode, TreeNode } from './profiles'
import { ProfileClient, buildGroupTree, newProfileID } from './profiles'
import { log } from './log'

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
const CRED_AUTH_MODES: AuthMode[] = ['password', 'publicKey', 'agent']

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
  const [editingCredential, setEditingCredential] = createSignal<Credential | null>(null)
  // Hoisted out of renderCredentialForm for the same reason the validation is:
  // that function runs inside a createMemo on `editingCredential()`, so a signal
  // declared there was rebuilt on every keystroke — typing a password and then
  // touching any other field discarded the password without saying so.
  const [passwordValue, setPasswordValue] = createSignal('')

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

  // ── Validation ──────────────────────────────────────────────────────────
  //
  // At component scope, NOT inside renderProfileForm. That function runs inside a
  // createMemo on `editing()`, so it re-runs on every keystroke — signals created
  // there would be thrown away and rebuilt each time, and "this field has been
  // answered" would reset itself as the user typed.
  //
  // The rules read `editing()` directly rather than taking the draft as an
  // argument, which is what lets the same object be read by the form (to render
  // the message) and by the submit handlers (to refuse).

  const profileValidation = createFormValidation({
    name: () => required('Name')(editing()?.name ?? ''),
    host: () => combine(required('Host'), hostname())(editing()?.options.host ?? ''),
    port: () => combine(required('Port'), portRule())(String(editing()?.options.port ?? '')),
    // Only when no credential is selected: a credential carries its own username,
    // and the User field is not even rendered in that case.
    user: () => {
      const p = editing()
      if (!p || p.options.credentialId) return undefined
      return required('User')(p.options.user ?? '')
    },
    keepaliveInterval: () =>
      nonNegativeInteger('Keepalive interval')(String(editing()?.options.keepaliveInterval ?? '')),
    keepaliveCountMax: () =>
      nonNegativeInteger('Keepalive count max')(String(editing()?.options.keepaliveCountMax ?? '')),
    readyTimeout: () =>
      nonNegativeInteger('Ready timeout')(String(editing()?.options.readyTimeout ?? '')),
  })

  const credentialValidation = createFormValidation({
    name: () => required('Name')(editingCredential()?.name ?? ''),
    username: () => required('Username')(editingCredential()?.username ?? ''),
    host: () => combine(required('Bind to Host'), hostname())(editingCredential()?.host ?? ''),
    port: () => portRule()(String(editingCredential()?.port ?? '')),
    keyPath: () => {
      const c = editingCredential()
      if (!c || c.auth !== 'publicKey') return undefined
      return required('Private key path')(c.keyPath ?? '')
    },
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

  // ── Actions ─────────────────────────────────────────────────────────────

  // Every entry point that swaps the record under a form resets that form's
  // validation. Without it the "already answered" marks carry over to the next
  // record and a freshly opened blank form opens with errors already showing.
  function handleProfileClick(p: SSHProfile) {
    setSelectedID(p.id)
    setEditing(null)
    setEditingCredential(null)
    profileValidation.reset()
    credentialValidation.reset()
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
    setEditingCredential(null)
    profileValidation.reset()
  }

  function showCredentialsPanel() {
    setSelectedID('')
    setEditing(null)
    setEditingCredential({
      id: '',
      name: '',
      username: '',
      auth: '',
    })
    credentialValidation.reset()
  }

  function editCredential(cred: Credential) {
    setSelectedID('')
    setEditing(null)
    setEditingCredential({ ...cred })
    credentialValidation.reset()
  }

  function cancelCredential() {
    setEditingCredential(null)
    credentialValidation.reset()
  }

  async function saveProfile(profile: SSHProfile) {
    if (!gate(profileValidation)) return
    if (!profile.id) {
      profile.id = newProfileID('ssh', profile.name)
    }
    try {
      await props.client.createProfile(profile)
      setSelectedID(profile.id)
      setEditing(null)
      profileValidation.reset()
      await loadAll()
      showToast({ level: 'success', message: `Saved "${profile.name}"` })
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to save', { message })
      // Was a log line and nothing else: the button appeared to do nothing and
      // the profile silently stayed unsaved.
      showToast({ level: 'danger', message: `Could not save the connection: ${message}` })
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

  async function deleteCredential(credential: Credential) {
    if (!(await showConfirm(`Delete credential "${credential.name}"?`))) return
    try {
      await props.client.deleteCredential(credential.id)
      setEditingCredential(null)
      await loadAll()
      showToast({ level: 'success', message: `Deleted credential "${credential.name}"` })
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to delete credential', { message })
      showToast({
        level: 'danger',
        message: `Could not delete "${credential.name}": ${message}`,
      })
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

  function renderCredentialListItem(cred: Credential) {
    const isSelected = editingCredential()?.id === cred.id
    return (
      <div
        classList={{ 'cm-item': true, 'cm-selected': isSelected }}
        onClick={() => editCredential(cred)}
      >
        <div class="cm-item-info">
          <div class="cm-item-name">{cred.name}</div>
          <div class="cm-item-meta">
            {cred.username} &bull; {authModeLabel(cred.auth)}
          </div>
        </div>
      </div>
    )
  }

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

    function setOption(key: keyof SSHProfile['options'], value: unknown) {
      const updated = { ...profile, options: { ...profile.options, [key]: value } }
      setEditing(updated)
    }

    function onNameChange(v: string) {
      const updated = { ...profile, name: v }
      if (!profile.id) updated.id = newProfileID('ssh', v)
      setEditing(updated)
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
          <TextField
            id="profile-host"
            label="Host"
            required
            value={profile.options.host}
            error={profileValidation.error('host')}
            onInput={(v) => setOption('host', v)}
            onBlur={() => profileValidation.touch('host')}
          />
          <TextField
            id="profile-port"
            label="Port"
            required
            // `?? 22`, not `|| 22`: with `||` a stored 0 displayed as 22, so
            // clearing the field snapped the box back to a number the profile did
            // not have while the rule complained about the one it did.
            value={profile.options.port ?? 22}
            type="number"
            error={profileValidation.error('port')}
            onInput={(v) => {
              const n = parseInt(v, 10)
              setOption('port', isNaN(n) ? 0 : n)
            }}
            onBlur={() => profileValidation.touch('port')}
          />

          <Field for="credential-select" label="Credential">
            <Select
              value={profile.options.credentialId ?? ''}
              onChange={(v) => setOption('credentialId', v || undefined)}
              options={credOptions()}
              placeholder="— None (specify below) —"
            />
          </Field>

          <Show when={!profile.options.credentialId}>
            <TextField
              id="profile-user"
              label="User"
              required
              value={profile.options.user || ''}
              error={profileValidation.error('user')}
              onInput={(v) => setOption('user', v)}
              onBlur={() => profileValidation.touch('user')}
            />
          </Show>
        </Section>

        <Show when={!profile.options.credentialId}>
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
                      checked={(profile.options.auth ?? '') === mode}
                      onChange={(v) => setOption('auth', v)}
                      name="auth-mode"
                      label={authModeLabel(mode)}
                    />
                  )}
                </For>
              </div>
            </Field>
          </Section>
        </Show>

        <Show when={!!profile.options.credentialId}>
          <div class="cm-form-section">
            <div class="cm-credential-card">
              <strong>Using Credential: </strong>
              <span>
                {(() => {
                  const cred = credentials().find((c) => c.id === profile.options.credentialId)
                  if (!cred) return 'Unknown'
                  return cred.name
                })()}
              </span>
              <br />
              <small>
                {(() => {
                  const cred = credentials().find((c) => c.id === profile.options.credentialId)
                  if (!cred) return ''
                  return `Username: ${cred.username} | Auth: ${authModeLabel(cred.auth)}`
                })()}
              </small>
            </div>
          </div>
        </Show>

        <Section title="Advanced">
          <TextField
            id="profile-keepalive-interval"
            label="Keepalive interval (ms)"
            value={profile.options.keepaliveInterval || 0}
            type="number"
            min={0}
            error={profileValidation.error('keepaliveInterval')}
            onInput={(v) => {
              const n = parseInt(v, 10)
              setOption('keepaliveInterval', isNaN(n) ? 0 : n)
            }}
            onBlur={() => profileValidation.touch('keepaliveInterval')}
          />
          <TextField
            id="profile-keepalive-count"
            label="Keepalive count max"
            value={profile.options.keepaliveCountMax || 0}
            type="number"
            min={0}
            error={profileValidation.error('keepaliveCountMax')}
            onInput={(v) => {
              const n = parseInt(v, 10)
              setOption('keepaliveCountMax', isNaN(n) ? 0 : n)
            }}
            onBlur={() => profileValidation.touch('keepaliveCountMax')}
          />
          <TextField
            id="profile-ready-timeout"
            label="Ready timeout (ms)"
            value={profile.options.readyTimeout || 0}
            type="number"
            min={0}
            error={profileValidation.error('readyTimeout')}
            onInput={(v) => {
              const n = parseInt(v, 10)
              setOption('readyTimeout', isNaN(n) ? 0 : n)
            }}
            onBlur={() => profileValidation.touch('readyTimeout')}
          />

          <Field for="jump-host" label="Jump server">
            <Select
              value={profile.options.jumpHost ?? ''}
              onChange={(v) => setOption('jumpHost', v || undefined)}
              options={jumpOptions()}
              placeholder="— None —"
            />
          </Field>

          <div class="cm-check-group">
            <Checkbox
              label="Agent forward"
              checked={profile.options.agentForward ?? false}
              onChange={(v) => setOption('agentForward', v)}
            />
            <Checkbox
              label="Can be used as jump server"
              checked={profile.options.canBeJumpServer ?? false}
              onChange={(v) => setOption('canBeJumpServer', v)}
            />
          </div>
        </Section>
        {/* Create/Save is the primary, not Connect. This is the connection *editor*
            — the action it exists for is committing the record in front of you.
            Connect is a shortcut out of it, and it was carrying the accent while
            the action the screen is named after looked secondary. */}
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

  // ── Credential form ────────────────────────────────────────────────────

  function renderCredentialForm(credential: Credential) {
    const isNew = !credential.id

    function updateField(key: keyof Credential, value: string) {
      const updated = { ...credential, [key]: value }
      if (key === 'name' && !credential.id) updated.id = `cred:${value}:${Date.now()}`
      setEditingCredential(updated)
    }

    async function saveCred() {
      if (!gate(credentialValidation)) return
      try {
        await props.client.createCredential(credential)
        if (credential.auth === 'password' && passwordValue()) {
          await props.client.savePassword(credential.id, passwordValue())
        }
        setEditingCredential(null)
        credentialValidation.reset()
        setPasswordValue('')
        await loadAll()
        showToast({ level: 'success', message: `Saved credential "${credential.name}"` })
      } catch (err) {
        const message = (err as Error).message
        log.error('Failed to save', { message })
        showToast({ level: 'danger', message: `Could not save the credential: ${message}` })
      }
    }
    return (
      <div class="cm-form">
        <Section title={isNew ? 'New Credential' : 'Edit Credential'}>
          <TextField
            id="cred-name"
            label="Name"
            required
            value={credential.name}
            error={credentialValidation.error('name')}
            onInput={(v) => updateField('name', v)}
            onBlur={() => credentialValidation.touch('name')}
          />
          <TextField
            id="cred-username"
            label="Username"
            required
            value={credential.username}
            error={credentialValidation.error('username')}
            onInput={(v) => updateField('username', v)}
            onBlur={() => credentialValidation.touch('username')}
          />

          <Field for="cred-auth-method" label="Authentication Method" orientation="horizontal">
            <div class="cm-radio-group">
              <For each={CRED_AUTH_MODES}>
                {(mode) => (
                  <Radio
                    value={mode}
                    checked={credential.auth === mode}
                    onChange={(v) => updateField('auth', v)}
                    name="cred-auth-mode"
                    label={authModeLabel(mode)}
                  />
                )}
              </For>
            </div>
          </Field>

          <Show when={credential.auth === 'password'}>
            <Field
              for="cred-password"
              label="Password (stored in OS keychain)"
              orientation="horizontal"
            >
              <TextField
                type="password"
                value={passwordValue()}
                onInput={(v) => setPasswordValue(v)}
                placeholder={credential.id ? 'Leave empty to keep current' : 'Enter password'}
              />
            </Field>
          </Show>

          <Show when={credential.auth === 'publicKey'}>
            <TextField
              id="cred-key-path"
              label="Private Key Path"
              required
              value={credential.keyPath || ''}
              error={credentialValidation.error('keyPath')}
              onInput={(v) => updateField('keyPath', v)}
              onBlur={() => credentialValidation.touch('keyPath')}
            />
          </Show>

          {/* The label no longer says "(required)" — the kit marks a required field
              and states the rule when it fails, so spelling it into the label was a
              second, unenforced copy of the same fact. */}
          <TextField
            id="cred-host"
            label="Bind to Host"
            required
            description="A credential names the one host it may be used for."
            value={credential.host || ''}
            error={credentialValidation.error('host')}
            onInput={(v) => updateField('host', v)}
            onBlur={() => credentialValidation.touch('host')}
          />
          <Show when={!!credential.host}>
            <TextField
              id="cred-port"
              label="Port"
              value={credential.port || 22}
              type="number"
              error={credentialValidation.error('port')}
              onInput={(v) => {
                const n = parseInt(v, 10)
                updateField('port', isNaN(n) ? '' : String(n))
              }}
              onBlur={() => credentialValidation.touch('port')}
            />
          </Show>
        </Section>

        {/* `.cm-form-error` is gone: one string for a whole form, which could only
            report the first failure and could not point at the field. Failures are
            per-field now, and anything the backend refuses is a toast. */}
        <div class="cm-form-actions">
          <Button variant="primary" onClick={() => void saveCred()}>
            {isNew ? 'Create Credential' : 'Save Credential'}
          </Button>
          <Show when={!isNew}>
            <Button variant="danger" onClick={() => void deleteCredential(credential)}>
              Delete Credential
            </Button>
          </Show>
          <Button variant="default" onClick={cancelCredential}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  // ── Form panel ─────────────────────────────────────────────────────────

  const formPanelContent = createMemo(() => {
    const cred = editingCredential()
    if (cred) return renderCredentialForm(cred)

    const ed = editing()
    if (ed) return renderProfileForm(ed)

    const selId = selectedID()
    if (selId) {
      const p = profiles().find((x) => x.id === selId)
      if (p) return renderProfileForm(p)
    }

    return renderEmpty()
  })

  // ── Main render ────────────────────────────────────────────────────────

  const tree = createMemo(() => buildGroupTree(groups()))
  const ungrouped = createMemo(() =>
    profiles().filter((p) => !p.group || !groups().some((g) => g.id === p.group)),
  )
  const hasCredentials = createMemo(() => credentials().length > 0)

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
        <Button
          variant="default"
          onClick={showCredentialsPanel}
          title="Manage saved passwords (keychain)"
        >
          Saved credentials
        </Button>
        <Button variant="primary" onClick={startNewProfile}>
          + New connection
        </Button>
      </Toolbar>
      <div class="cm-body">
        <div class="cm-list">
          <Show when={hasCredentials()}>
            <div class="cm-group-header">Saved Credentials</div>
            <For each={credentials()}>{(cred) => renderCredentialListItem(cred)}</For>
          </Show>

          <Show
            when={profiles().length > 0 || credentials().length > 0}
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
