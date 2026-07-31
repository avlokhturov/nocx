/**
 * SecretsSection — vault contents page, one row per stored value.
 *
 * Replaces the old CredentialsSection. Shows a permanent explanation line,
 * then the vault inventory when unsealed, or a locked state when sealed.
 *
 * No Reveal, no Copy of a stored value. Settlement: ADR-0011 §2 and
 * vault design §3.1.
 */
import { For, Show, Switch, Match, createSignal, createEffect, onMount } from 'solid-js'
import { Button } from './ui/button'
import { EmptyState } from './ui/empty-state'
import { PageSection } from './ui/page-section'
import { CollectionRow } from './ui/collection-view'
import { Badge } from './ui/badge'
import { KeyIcon, LockIcon } from './ui/icons'
import { showToast } from './ui/toast'
import type { VaultClient, VaultInventoryEntry } from './vault-client'
import type { VaultController } from './vault'
import { log } from './log'

export interface SecretsSectionProps {
  vaultClient: VaultClient
  vaultController: VaultController
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; entries: VaultInventoryEntry[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }

const STORE_LABELS: Record<string, string> = {
  system: 'System keychain',
  file: 'Encrypted nocx storage',
}

export function SecretsSection(props: SecretsSectionProps) {
  const [loadState, setLoadState] = createSignal<LoadState>({ kind: 'loading' })

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

  return (
    <div class="sr-root">
      {/* No standing description line above everything. It used to sit at the
          very top of the page in every state, so a locked vault showed a wall
          of body copy with no heading over it and a centred plate floating
          below — the spec's own rule for this surface is "sealed: a locked
          state and one action, nothing else", and the line broke it.

          Where it belongs is on the section it describes: "never shown back to
          you" answers a question you only have once you are looking at a list
          of secrets and wondering whether you can read one. */}
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
            description="There are no passwords or key passphrases in the vault yet. They appear here when you add a password to a connection."
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
                      {/* One glyph for every kind. The emoji pair this replaced
                          encoded which store holds the secret — which the store
                          name on the right of the same row already says, in
                          words, and says for stores no emoji was chosen for. */}
                      <span class="sr-row-icon">
                        <KeyIcon />
                      </span>
                      <div class="sr-row-body">
                        <span class="sr-row-label">{entry.label}</span>
                        <span class="sr-row-usage">
                          {entry.usedBy} connection{entry.usedBy === 1 ? '' : 's'}
                        </span>
                      </div>
                    </div>
                  }
                  actions={
                    <>
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
          </PageSection>
        </Match>
      </Switch>
    </div>
  )
}
