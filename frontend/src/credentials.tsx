/**
 * CredentialsSection — settings page for credential management.
 *
 * Full-width list of credential rows. Editing happens in a kit Dialog.
 * Delete shows which profiles use the credential (blast radius), including
 * inherited usage via groups.
 */
import { For, Show, createSignal, createMemo, onMount } from 'solid-js'
import { Button } from './ui/button'
import { showConfirm } from './ui/dialog'
import { Dialog } from './ui/dialog'
import { EmptyState } from './ui/empty-state'
import { showToast } from './ui/toast'
import type { Credential, CredentialUsage, ProfileClient } from './profiles'
import { log } from './log'
import { CredentialForm, type CredentialFormHandle } from './credential-form'
import { RolloutPanel } from './rollout-panel'
import { CollectionRow, CollectionView } from './ui/collection-view'
import { IconButton } from './ui/icon-button'
import { PencilIcon, TrashIcon } from './ui/icons'

export interface CredentialsSectionProps {
  client: ProfileClient
}

function authModeLabel(mode: string): string {
  switch (mode) {
    case 'password':
      return 'password'
    case 'publicKey':
      return 'public key'
    case 'agent':
      return 'SSH agent'
    default:
      return mode
  }
}

function usageSubtitle(cred: Credential, usageMap: Map<string, CredentialUsage>): string {
  const n = usageMap.get(cred.id)?.profiles.length ?? 0
  const base = [cred.username, authModeLabel(cred.auth)].filter(Boolean).join(' \u00b7 ')
  if (n === 0) return base + ' \u00b7 not used by anything'
  return base + ' \u00b7 ' + n + ' connection' + (n === 1 ? '' : 's')
}

export function CredentialsSection(props: CredentialsSectionProps) {
  const [credentials, setCredentials] = createSignal<Credential[]>([])
  const [usage, setUsage] = createSignal<CredentialUsage[]>([])
  const [dialogOpen, setDialogOpen] = createSignal(false)
  const [editingCred, setEditingCred] = createSignal<Credential | null>(null)
  const [passwordValue, setPasswordValue] = createSignal('')
  const [rolloutCred, setRolloutCred] = createSignal<Credential | null>(null)
  const [rolloutOpen, setRolloutOpen] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal('')
  // Staged rollout is behind a flag while its shape is decided. The apparatus
  // answers a question a domain-controlled fleet does not ask, and it carries a
  // known gap (nocx-jb20.4) — so it is off unless someone turns it on, rather
  // than a button somebody finds.
  const [rotationEnabled, setRotationEnabled] = createSignal(false)

  const formRef = { current: null as CredentialFormHandle | null }

  const usageMap = createMemo(() => {
    const m = new Map<string, CredentialUsage>()
    for (const u of usage()) {
      m.set(u.credentialId, u)
    }
    return m
  })
  const filteredCredentials = createMemo(() => {
    const query = searchQuery().trim().toLowerCase()
    if (!query) return credentials()
    return credentials().filter((credential) =>
      [credential.name, credential.username, authModeLabel(credential.auth)].some((value) =>
        value.toLowerCase().includes(query),
      ),
    )
  })

  async function loadAll() {
    try {
      const [c, u] = await Promise.all([
        props.client.listCredentials(),
        props.client.credentialUsage(),
      ])
      setCredentials(c ?? [])
      setUsage(u?.usage ?? [])
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to load credentials', { message })
      showToast({
        level: 'danger',
        message: 'Could not load credentials: ' + message,
      })
    }
  }

  onMount(() => {
    void loadAll()
    props.client
      .getSnapshot()
      .then((snap) => {
        setRotationEnabled(snap.values['credentials.rotationEnabled'] === true)
      })
      .catch((err: unknown) => {
        // A snapshot that does not arrive leaves the flag off, which is the
        // safe direction: the tools stay hidden rather than appearing by
        // accident.
        log.warn('Could not read the rotation flag', { message: (err as Error).message })
      })
  })

  function openNewDialog() {
    setEditingCred({
      id: '',
      name: '',
      username: '',
      auth: '',
    })
    setPasswordValue('')
    formRef.current?.reset()
    setDialogOpen(true)
  }

  function openEditDialog(cred: Credential) {
    setEditingCred({ ...cred })
    setPasswordValue('')
    formRef.current?.reset()
    setDialogOpen(true)
  }

  function closeDialog() {
    setDialogOpen(false)
    setEditingCred(null)
    setPasswordValue('')
  }

  function openRolloutDialog(cred: Credential) {
    setRolloutCred(cred)
    setRolloutOpen(true)
  }

  function closeRolloutDialog() {
    setRolloutOpen(false)
    setRolloutCred(null)
  }

  async function handleRolloutStateChange() {
    await loadAll()
    const id = rolloutCred()?.id
    if (id) {
      const fresh = credentials().find((c) => c.id === id)
      if (fresh) setRolloutCred({ ...fresh })
    }
  }

  async function handleSave() {
    const cred = editingCred()
    if (!cred) return
    if (!formRef.current?.valid()) {
      formRef.current?.revealAll()
      const msg = formRef.current?.error('name') ?? 'Please fill in all required fields'
      showToast({ level: 'warning', message: msg })
      return
    }

    setSaving(true)
    try {
      let saved: Credential
      if (cred.id) {
        saved = await props.client.updateCredential(cred)
      } else {
        saved = await props.client.createCredential(cred)
      }

      if (cred.auth === 'password' && passwordValue()) {
        await props.client.savePassword(saved.id, passwordValue())
      }

      closeDialog()
      await loadAll()
      showToast({ level: 'success', message: 'Saved credential "' + saved.name + '"' })
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to save credential', { message })
      showToast({ level: 'danger', message: 'Could not save the credential: ' + message })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(cred: Credential) {
    const u = usageMap().get(cred.id)

    if (u && u.profiles.length > 0) {
      const profileLines = u.profiles
        .map((p) => {
          if (p.source === 'group') {
            return (
              '  - ' +
              p.profileName +
              ' (inherited from group "' +
              (p.groupName ?? p.groupId ?? 'unknown') +
              '")'
            )
          }
          if (p.source === 'global') {
            return '  - ' + p.profileName + ' (inherited from global defaults)'
          }
          return '  - ' + p.profileName
        })
        .join('\n')

      const confirmed = await showConfirm(
        'Delete credential "' +
          cred.name +
          '"?\n\nThis credential is used by ' +
          u.profiles.length +
          ' connection(s):\n' +
          profileLines,
        'Delete',
        'Cancel',
      )
      if (!confirmed) return
    } else {
      if (
        !(await showConfirm(
          'Delete credential "' +
            cred.name +
            '"?\nThis credential is not currently used by any connection.',
          'Delete',
          'Cancel',
        ))
      )
        return
    }

    try {
      await props.client.deleteCredential(cred.id)
      closeDialog()
      await loadAll()
      showToast({ level: 'success', message: 'Deleted credential "' + cred.name + '"' })
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to delete credential', { message })
      showToast({
        level: 'danger',
        message: 'Could not delete "' + cred.name + '": ' + message,
      })
    }
  }

  function handleFieldChange(key: keyof Credential, value: string) {
    const cred = editingCred()
    if (!cred) return
    setEditingCred({ ...cred, [key]: value })
  }

  return (
    <div class="cr-root">
      <CollectionView
        searchValue={searchQuery()}
        onSearch={setSearchQuery}
        searchPlaceholder="Filter credentials"
        searchLabel="Filter credentials"
        actions={
          <Button variant="primary" onClick={openNewDialog}>
            + New credential
          </Button>
        }
        hasItems={credentials().length > 0}
        empty={
          <EmptyState
            title="No saved credentials"
            description="Create a reusable authentication identity for your connections."
            action={
              <Button variant="primary" onClick={openNewDialog}>
                + New credential
              </Button>
            }
          />
        }
      >
        <div role="list" aria-label="Credential list">
          <For each={filteredCredentials()}>
            {(cred) => {
              const subtitle = () => usageSubtitle(cred, usageMap())
              return (
                <CollectionRow
                  info={
                    <>
                      <div class="cr-item-name">{cred.name}</div>
                      <div class="cr-item-meta">{subtitle()}</div>
                    </>
                  }
                  actions={
                    <>
                      <Show when={rotationEnabled() && cred.auth === 'password'}>
                        <Button variant="default" size="sm" onClick={() => openRolloutDialog(cred)}>
                          Rollout
                        </Button>
                      </Show>
                      <IconButton
                        size="sm"
                        title="Edit"
                        ariaLabel={`Edit ${cred.name}`}
                        onClick={() => openEditDialog(cred)}
                      >
                        <PencilIcon />
                      </IconButton>
                      <IconButton
                        size="sm"
                        title="Delete"
                        ariaLabel={`Delete ${cred.name}`}
                        onClick={() => void handleDelete(cred)}
                      >
                        <TrashIcon />
                      </IconButton>
                    </>
                  }
                />
              )
            }}
          </For>
          <Show when={searchQuery().trim() !== '' && filteredCredentials().length === 0}>
            <EmptyState
              title="Nothing matches this filter"
              description={`No credential's name, user or method contains "${searchQuery().trim()}".`}
            />
          </Show>
        </div>
      </CollectionView>

      <Show when={editingCred()}>
        {(cred) => (
          <Dialog
            open={dialogOpen()}
            onClose={closeDialog}
            title={cred().id ? 'Edit Credential' : 'New Credential'}
            size="lg"
            onSubmit={() => void handleSave()}
            footer={
              <>
                <Button variant="primary" onClick={() => void handleSave()} disabled={saving()}>
                  {saving() ? 'Saving...' : cred().id ? 'Save Credential' : 'Create Credential'}
                </Button>
                <Show when={cred().id}>
                  <Button
                    variant="danger"
                    onClick={() => void handleDelete(cred())}
                    disabled={saving()}
                  >
                    Delete Credential
                  </Button>
                </Show>
                <Button variant="default" onClick={closeDialog} disabled={saving()}>
                  Cancel
                </Button>
              </>
            }
          >
            <CredentialForm
              credential={cred()}
              onFieldChange={handleFieldChange}
              passwordValue={passwordValue()}
              onPasswordChange={setPasswordValue}
              ref={formRef}
            />
          </Dialog>
        )}
      </Show>

      <Show when={rolloutCred()}>
        {(cred) => (
          <Dialog
            open={rolloutOpen()}
            onClose={closeRolloutDialog}
            title={'Rollout: ' + cred().name}
          >
            <RolloutPanel
              client={props.client}
              credential={cred()}
              usage={usageMap().get(cred().id) ?? null}
              onStateChange={() => void handleRolloutStateChange()}
            />
          </Dialog>
        )}
      </Show>
    </div>
  )
}
