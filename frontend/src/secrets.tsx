/**
 * SecretsSection — vault contents page, one row per stored value.
 *
 * Replaces the old CredentialsSection. Shows a permanent explanation line,
 * then the vault inventory when unsealed, or a locked state when sealed.
 *
 * The secret owns its name (ADR-0016): each row renders the vault's name for
 * the secret — never derived, never blank, never a reference — and the page
 * offers Add (the user is asked for the name) and Rename. A secret with no
 * connection using it is a row like any other; that is the point of the ADR.
 *
 * No Reveal, no Copy of a stored value. Settlement: ADR-0011 §2 and
 * vault design §3.1.
 */
import { For, Show, Switch, Match, createSignal, createEffect, onMount } from 'solid-js'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { EmptyState } from './ui/empty-state'
import { PageSection } from './ui/page-section'
import { CollectionRow } from './ui/collection-view'
import { Badge } from './ui/badge'
import { Dialog } from './ui/dialog'
import { Stack } from './ui/stack'
import { TextField } from './ui/text-field'
import { SegmentedControl } from './ui/segmented-control'
import { createFormValidation, required } from './ui/validation'
import { KeyIcon, LockIcon, PencilIcon } from './ui/icons'
import { showToast } from './ui/toast'
import type { VaultClient, InventoryEntry } from './vault-client'
import type { VaultController } from './vault'
import { log } from './log'

export interface SecretsSectionProps {
  vaultClient: VaultClient
  vaultController: VaultController
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; entries: InventoryEntry[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }

const STORE_LABELS: Record<string, string> = {
  system: 'System keychain',
  file: 'Encrypted nocx storage',
}

// The kinds a user can create on this page. The wire vocabulary is closed and
// wider; this page offers the two the surface names today.
const ADD_KINDS = [
  { value: 'password', label: 'Password' },
  { value: 'key-passphrase', label: 'Key passphrase' },
] as const

export function SecretsSection(props: SecretsSectionProps) {
  const [loadState, setLoadState] = createSignal<LoadState>({ kind: 'loading' })

  // Add-secret dialog state.
  const [addOpen, setAddOpen] = createSignal(false)
  const [addName, setAddName] = createSignal('')
  const [addKind, setAddKind] = createSignal<'password' | 'key-passphrase'>('password')
  const [addValue, setAddValue] = createSignal('')
  const [addBusy, setAddBusy] = createSignal(false)
  const addValidation = createFormValidation({
    name: () => required('Name')(addName()),
    value: () => required('Value')(addValue()),
  })

  // Rename dialog state — the row being renamed, addressed by its opaque
  // handle, never by a secret reference (nocx-jb20.1).
  const [renameTarget, setRenameTarget] = createSignal<InventoryEntry | null>(null)
  const [renameName, setRenameName] = createSignal('')
  const [renameBusy, setRenameBusy] = createSignal(false)
  const renameValidation = createFormValidation({
    name: () => required('Name')(renameName()),
  })

  const status = () => props.vaultController.status()

  async function load(): Promise<void> {
    setLoadState({ kind: 'loading' })
    try {
      const inv = await props.vaultClient.inventory()
      if (inv.entries.length === 0) {
        setLoadState({ kind: 'empty' })
      } else {
        setLoadState({ kind: 'loaded', entries: inv.entries })
      }
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to load secrets', { message })
      showToast({ level: 'danger', message: 'Could not load secrets: ' + message })
      setLoadState({ kind: 'error', message })
    }
  }

  // Refresh status on mount. The createEffect on status() below handles
  // loading inventory once the vault state is known.
  onMount(() => {
    void props.vaultController.refresh()
  })

  // Load inventory when the vault transitions to unsealed.
  createEffect(() => {
    const s = status()
    if (s && s.state === 'unsealed') {
      void load()
    }
  })

  function openAdd(): void {
    addValidation.reset()
    setAddName('')
    setAddKind('password')
    setAddValue('')
    setAddOpen(true)
  }

  function closeAdd(): void {
    if (addBusy()) return
    setAddOpen(false)
  }

  async function submitAdd(): Promise<void> {
    if (!addValidation.valid()) {
      addValidation.revealAll()
      return
    }
    setAddBusy(true)
    try {
      await props.vaultClient.createSecret({
        name: addName().trim(),
        kind: addKind(),
        value: addValue(),
      })
      setAddOpen(false)
      showToast({ level: 'success', message: `Added "${addName().trim()}"` })
      void load()
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to add secret', { message })
      showToast({ level: 'danger', message: `Could not add secret: ${message}` })
    } finally {
      setAddBusy(false)
    }
  }

  function openRename(entry: InventoryEntry): void {
    renameValidation.reset()
    setRenameTarget(entry)
    setRenameName(entry.name)
  }

  function closeRename(): void {
    if (renameBusy()) return
    setRenameTarget(null)
  }

  async function submitRename(): Promise<void> {
    const entry = renameTarget()
    if (!entry) return
    if (!renameValidation.valid()) {
      renameValidation.revealAll()
      return
    }
    setRenameBusy(true)
    try {
      await props.vaultClient.renameSecret({ id: entry.id, name: renameName().trim() })
      setRenameTarget(null)
      showToast({ level: 'success', message: `Renamed to "${renameName().trim()}"` })
      void load()
    } catch (err) {
      const message = (err as Error).message
      log.error('Failed to rename secret', { message })
      showToast({ level: 'danger', message: `Could not rename secret: ${message}` })
    } finally {
      setRenameBusy(false)
    }
  }

  return (
    <div class="sr-root">
      {/* A Switch, not nested Shows. The nested form made a missing case
          invisible: `uninitialized` fell through every branch and the page
          rendered nothing at all — a blank panel, no heading, no plate — and
          so did `loading` and `error`. Only `sealed`, `empty` and `loaded`
          were ever named, because before the vault could be reset there was
          no easy way to reach the others with this page open. A Switch makes
          the set of states something you have to look at. */}
      <Switch fallback={<EmptyState icon={<KeyIcon />} title="Loading secrets…" />}>
        <Match when={status()?.state === 'uninitialized'}>
          <EmptyState
            icon={<LockIcon />}
            title="Protection is not set up yet"
            description="nocx has nowhere to keep passwords until protection is set up. Nothing is stored, and nothing is lost."
            action={
              <Button variant="primary" onClick={() => props.vaultController.openSetup()}>
                Set up protection
              </Button>
            }
          />
        </Match>

        <Match when={status()?.state === 'sealed'}>
          <EmptyState
            icon={<LockIcon />}
            title="Vault is locked"
            description="Unlock the vault to see what secrets it holds."
            action={
              <Button variant="primary" onClick={() => props.vaultController.openUnlock()}>
                Unlock vault
              </Button>
            }
          />
        </Match>

        <Match when={loadState().kind === 'error'}>
          <EmptyState
            icon={<KeyIcon />}
            title="Could not load secrets"
            description={(loadState() as Extract<LoadState, { kind: 'error' }>).message}
            action={
              <Button variant="default" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        </Match>

        <Match when={loadState().kind === 'empty'}>
          <EmptyState
            icon={<KeyIcon />}
            title="Vault is empty"
            description="There are no secrets in the vault yet. Add one here, or save a password on a connection and it appears."
            action={
              <Button variant="primary" onClick={openAdd}>
                Add a secret
              </Button>
            }
          />
        </Match>

        <Match when={loadState().kind === 'loaded'}>
          <PageSection
            title="Secrets"
            description="These are the passwords and key passphrases nocx keeps for your connections. They are stored encrypted and never shown back to you."
            divided
          >
            <For each={(loadState() as Extract<LoadState, { kind: 'loaded' }>).entries}>
              {(entry) => (
                <CollectionRow
                  info={
                    <div class="sr-row-info">
                      <span class="sr-row-icon">
                        <KeyIcon />
                      </span>
                      <div class="sr-row-body">
                        <span class="sr-row-label">{entry.name}</span>
                        <span class="sr-row-usage">
                          {entry.usedBy} connection{entry.usedBy === 1 ? '' : 's'}
                        </span>
                      </div>
                    </div>
                  }
                  actions={
                    <>
                      <IconButton
                        size="md"
                        ariaLabel={`Rename ${entry.name}`}
                        title="Rename secret"
                        onClick={() => openRename(entry)}
                      >
                        <PencilIcon />
                      </IconButton>
                      <span class="sr-row-store">
                        {STORE_LABELS[entry.provider] ?? entry.provider}
                      </span>
                      <Show when={!entry.reachable}>
                        <Badge tone="danger">Store unreachable</Badge>
                      </Show>
                    </>
                  }
                />
              )}
            </For>
            <div class="sr-add-row">
              <Button variant="default" onClick={openAdd}>
                Add a secret
              </Button>
            </div>
          </PageSection>
        </Match>
      </Switch>

      {/* Add dialog — the user was asked for the name and the kind, because
          they set out to create a secret (ADR-0016). Mounted only while open:
          the value field is a password input and must not sit in the DOM (or
          the accessibility tree) of a closed page. */}
      <Show when={addOpen()}>
        <Dialog
          open={addOpen()}
          onClose={closeAdd}
          title="Add secret"
          onSubmit={() => void submitAdd()}
          footer={
            <>
              <Button variant="primary" onClick={() => void submitAdd()} disabled={addBusy()}>
                Add secret
              </Button>
              <Button variant="default" onClick={closeAdd} disabled={addBusy()}>
                Cancel
              </Button>
            </>
          }
        >
          <Stack gap="default">
            <TextField
              id="sr-add-name"
              label="Name"
              placeholder="e.g. prod password"
              value={addName()}
              onInput={setAddName}
              onBlur={() => addValidation.touch('name')}
              error={addValidation.error('name')}
              required
            />
            <SegmentedControl
              options={ADD_KINDS as unknown as { value: string; label: string }[]}
              value={addKind()}
              onChange={(v) => setAddKind(v as 'password' | 'key-passphrase')}
              ariaLabel="Kind"
            />
            <TextField
              id="sr-add-value"
              label="Value"
              type="password"
              value={addValue()}
              onInput={setAddValue}
              onBlur={() => addValidation.touch('value')}
              error={addValidation.error('value')}
              required
            />
          </Stack>
        </Dialog>
      </Show>

      {/* Rename dialog — addressed by the row's opaque handle. */}
      <Show when={renameTarget()}>
        {(target) => (
          <Dialog
            open={true}
            onClose={closeRename}
            title={`Rename "${target().name}"`}
            onSubmit={() => void submitRename()}
            footer={
              <>
                <Button
                  variant="primary"
                  onClick={() => void submitRename()}
                  disabled={renameBusy()}
                >
                  Rename
                </Button>
                <Button variant="default" onClick={closeRename} disabled={renameBusy()}>
                  Cancel
                </Button>
              </>
            }
          >
            <Stack gap="default">
              <TextField
                id="sr-rename-name"
                label="Name"
                value={renameName()}
                onInput={setRenameName}
                onBlur={() => renameValidation.touch('name')}
                error={renameValidation.error('name')}
                required
              />
            </Stack>
          </Dialog>
        )}
      </Show>
    </div>
  )
}
