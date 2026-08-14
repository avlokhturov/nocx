// @vitest-environment jsdom
/**
 * Component-level acceptance for the AI endpoints surface (nocx-kn9q,
 * design §4.5, ADR-0030).
 *
 * Drives the real EndpointsSection the way a user drives it — the buttons,
 * not the handlers — against a client whose four methods are spied, and
 * asserts the wire and the surface together: an add reaches
 * endpoints.create with the key once, an edit reaches endpoints.update with
 * the unchanged id, a delete reaches endpoints.delete after a confirm, a
 * refused submit keeps every call off the wire and announces through the
 * kit gate, and a backend refusal is said on the surface.
 */
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest'
import { cleanup, render, fireEvent } from '@solidjs/testing-library'
import { EndpointsSection } from './endpoints-section'
import { EndpointClient, type Endpoint, type EndpointWrite } from './endpoints'
import { AgentClient } from './agent'
import type { AgentStatusResult } from './generated/agent.status'
import { Dispatcher, RpcError } from './dispatcher'
import { clearToasts, toasts } from './ui'
import { SetupDialog, createVaultState, type VaultController } from './vault'
import type { VaultClient } from './vault-client'

/** One stored endpoint as the wire declares it. */
function ep(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: 'endpoint:custom:provider:1',
    name: 'provider',
    baseUrl: 'https://api.example.com/v1',
    schema: 'openai-compatible',
    credential: null,
    models: [{ name: 'gpt-4o', alias: null }],
    ...overrides,
  }
}

/**
 * A recording client over a mutable store: list reads the store, create
 * pushes, update replaces in place, delete removes — so a save's reload
 * shows the change, exactly the round trip the real backend makes.
 */
function createHarness(initial: Endpoint[] = [], opts: { firstListError?: Error } = {}) {
  const store: Endpoint[] = [...initial]
  let next = 1
  const client = new EndpointClient(new Dispatcher())
  // The real client's methods are async; these fakes match their signatures
  // and answer from the store, so there is nothing to await.
  // eslint-disable-next-line @typescript-eslint/require-await
  const listEndpoints = vi.spyOn(client, 'listEndpoints').mockImplementation(async () => {
    // The mount-time load is the first call; a harness that wants the load
    // to fail must arm it before the component renders, or the rejection
    // lands on the retry instead.
    if (opts.firstListError) {
      const err = opts.firstListError
      opts.firstListError = undefined
      throw err
    }
    return [...store]
  })
  const createEndpoint = vi
    .spyOn(client, 'createEndpoint')
    // eslint-disable-next-line @typescript-eslint/require-await
    .mockImplementation(async (input: EndpointWrite) => {
      const created: Endpoint = {
        id: `endpoint:custom:${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${next++}`,
        name: input.name,
        baseUrl: input.baseUrl,
        schema: 'openai-compatible',
        // The backend mints the key into the vault and returns only the row
        // handle — the value never crosses back.
        credential: input.key !== '' ? `secrow:${next++}` : null,
        models: input.models.map((m) => ({ name: m.name, alias: m.alias })),
      }
      store.push(created)
      return created
    })
  const updateEndpoint = vi
    .spyOn(client, 'updateEndpoint')
    // eslint-disable-next-line @typescript-eslint/require-await
    .mockImplementation(async (id: string, input: EndpointWrite) => {
      const index = store.findIndex((e) => e.id === id)
      if (index < 0) throw new Error('endpoint not found')
      const existing = store[index]
      const updated: Endpoint = {
        ...existing,
        name: input.name,
        baseUrl: input.baseUrl,
        models: input.models.map((m) => ({ name: m.name, alias: m.alias })),
      }
      store[index] = updated
      return updated
    })
  const deleteEndpoint = vi
    .spyOn(client, 'deleteEndpoint')
    // eslint-disable-next-line @typescript-eslint/require-await
    .mockImplementation(async (id: string) => {
      store.splice(
        store.findIndex((e) => e.id === id),
        1,
      )
      return {}
    })
  const probeEndpoint = vi.spyOn(client, 'probeEndpoint').mockImplementation(
    // eslint-disable-next-line @typescript-eslint/require-await
    async (input: { name: string; baseUrl: string; key: string; model: string }) => {
      // A backend probe answers with a result — the Test button's whole
      // contract is that a failed probe is a RESULT, not an error.
      return {
        name: input.name,
        model: input.model,
        ok: true,
        elapsedMs: 12,
        at: new Date().toISOString(),
      }
    },
  )
  return {
    client,
    listEndpoints,
    createEndpoint,
    updateEndpoint,
    deleteEndpoint,
    probeEndpoint,
    store,
  }
}

function mount(
  initial: Endpoint[] = [],
  opts?: { firstListError?: Error; vaultController?: VaultController },
) {
  const harness = createHarness(initial, opts)
  const container = document.body.appendChild(document.createElement('div'))
  render(
    () => <EndpointsSection client={harness.client} vaultController={opts?.vaultController} />,
    { container },
  )
  return { ...harness, container }
}

/** A status-stubbing agent client: the readiness line renders only when an
 *  agent client is present, so tests that exercise it pass one. */
function agentHarness(status: AgentStatusResult) {
  const agentClient = new AgentClient(new Dispatcher())
  vi.spyOn(agentClient, 'status').mockResolvedValue(status)
  return agentClient
}

function mountWithAgent(status: AgentStatusResult, initial: Endpoint[] = []) {
  const harness = createHarness(initial)
  const container = document.body.appendChild(document.createElement('div'))
  render(() => <EndpointsSection client={harness.client} agentClient={agentHarness(status)} />, {
    container,
  })
  return { ...harness, container }
}

afterEach(() => {
  clearToasts()
  vi.clearAllMocks()
  cleanup()
  document.body.innerHTML = ''
})

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.ui-collection-row'))
}

async function waitForRows(container: HTMLElement, count: number) {
  await vi.waitFor(() => {
    expect(rows(container).length).toBe(count)
  })
}

function findDialogByTitle(container: HTMLElement, partial: string): HTMLElement | null {
  const titles = container.querySelectorAll('.nocx-dialog__title')
  for (const t of titles) {
    if (t.textContent && t.textContent.includes(partial)) return t.closest('.nocx-dialog')
  }
  return null
}

/** The confirm dialog mounts on document.body (showConfirm's own root), so
 *  it is found by its message text, not its title. */
function findConfirmDialog(message: string): HTMLElement | null {
  const dialogs = document.querySelectorAll('.nocx-dialog')
  for (const d of dialogs) {
    const msg = d.querySelector('.nocx-dialog__message')
    if (msg?.textContent === message) return d as HTMLElement
  }
  return null
}

function clickButton(container: HTMLElement, label: string, scope?: HTMLElement) {
  const root = scope ?? container
  const btn = Array.from(root.querySelectorAll('.ui-button')).find(
    (b) => b.textContent?.trim() === label,
  )
  expect(btn, `button "${label}" not found`).toBeTruthy()
  fireEvent.click(btn!)
}

function fillField(container: HTMLElement, id: string, value: string) {
  const field = container.querySelector(`#${id}`) as HTMLInputElement
  expect(field, `field #${id} not found`).toBeTruthy()
  fireEvent.input(field, { target: { value } })
}

function openNew(container: HTMLElement) {
  clickButton(container, '+ New endpoint')
  const dialog = findDialogByTitle(container, 'New Endpoint')
  expect(dialog, 'new-endpoint dialog did not open').toBeTruthy()
  return dialog!
}

function openEdit(container: HTMLElement, name: string) {
  const editBtn = container.querySelector(`.ui-collection-row__actions [aria-label="Edit ${name}"]`)
  expect(editBtn, `Edit button for "${name}" not found`).toBeTruthy()
  fireEvent.click(editBtn!)
  const dialog = findDialogByTitle(container, name)
  expect(dialog, `edit dialog for "${name}" did not open`).toBeTruthy()
  return dialog!
}

function toastMessages(): string[] {
  return toasts().map((t) => t.message)
}

/** Flush the microtask chain deterministically — the repo's convention for
 *  "let a promise rejection propagate" (no real timers, AGENTS.md). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** The vault seam harness: a REAL vault controller over a stubbed client.
 *  `status` and `setup` stay visible so a test can re-mock them. */
interface VaultHarness {
  ctrl: VaultController
  client: VaultClient
  status: Mock
  setup: Mock
}

/** A real controller on a fresh install: the vault is uninitialized with no
 *  OS key, so any secret mint must raise the vault layer's own setup sheet
 *  (the nocx-v64o behavior the connections path already has). */
function vaultHarness(statusOverride: Record<string, unknown> = {}): VaultHarness {
  const status = vi.fn().mockResolvedValue({
    state: 'uninitialized' as const,
    osKeyAvailable: false,
    osKeyCapable: false,
    hasPassphrase: false,
    autoSealMinutes: 0,
    providers: [],
    defaultProvider: null,
    ...statusOverride,
  })
  const setup = vi.fn().mockResolvedValue({})
  const client = { status, setup } as unknown as VaultClient
  const ctrl = createVaultState(client)
  return { ctrl, client, status, setup }
}

/** Mount the section with the vault seam AND the vault layer's own setup
 *  dialog, wired exactly as main.tsx wires them — so a key-creation save on
 *  an unprotected install raises the real setup sheet and resumes through
 *  it, the same journey a person takes. */
function mountWithVault(initial: Endpoint[] = [], vault: VaultHarness = vaultHarness()) {
  const harness = createHarness(initial)
  const container = document.body.appendChild(document.createElement('div'))
  render(
    () => (
      <>
        <EndpointsSection client={harness.client} vaultController={vault.ctrl} />
        <SetupDialog
          open={vault.ctrl.showSetup()}
          onClose={() => vault.ctrl.closeSetup()}
          onSetupComplete={() => vault.ctrl.onSetupDone()}
          vaultClient={vault.client}
        />
      </>
    ),
    { container },
  )
  return { ...harness, ...vault, container }
}

describe('AI endpoints surface — real surface, real client seam', () => {
  it('adds an endpoint: the fields reach endpoints.create and the saved row appears', async () => {
    const { container, createEndpoint } = mount()
    await waitForRows(container, 0)

    const dialog = openNew(container)
    fillField(container, 'endpoint-name', 'My provider')
    fillField(container, 'endpoint-base-url', 'https://api.example.com/v1')
    fillField(container, 'endpoint-key', 'sk-live-abc')
    clickButton(dialog, 'Add model')
    fillField(container, 'endpoint-model-0-name', 'gpt-4o')
    fillField(container, 'endpoint-model-0-alias', 'Flagship')
    clickButton(dialog, 'Create Endpoint')

    await vi.waitFor(() => {
      expect(createEndpoint).toHaveBeenCalledTimes(1)
    })
    // No schema on the wire: the form has no dialect control while one
    // schema exists (design §4.5, decision 2), so the backend owns the
    // value and completes it at the wire seam (ws_endpoints.go
    // resolveEndpointSchema) — this exact absence is what that default
    // fills, and it is pinned on the other side by the transport's
    // renderer-shape over-socket test (nocx-qtim).
    expect(createEndpoint.mock.calls[0][0]).toEqual({
      name: 'My provider',
      baseUrl: 'https://api.example.com/v1',
      key: 'sk-live-abc',
      models: [{ name: 'gpt-4o', alias: 'Flagship' }],
    })

    // The saved row appears in the list, saying the key is saved — but never
    // the key itself.
    await waitForRows(container, 1)
    const row = rows(container)[0]
    expect(row.textContent).toContain('My provider')
    expect(row.textContent).toContain('Key saved')
    expect(row.textContent).not.toContain('sk-live-abc')
    expect(toastMessages()).toContain('Saved "My provider"')
  })

  it('never reads a key back: the form opens empty on an endpoint that has one', async () => {
    const { container } = mount([
      ep({ id: 'endpoint:custom:provider:1', name: 'provider', credential: 'secrow:9' }),
    ])
    await waitForRows(container, 1)

    const dialog = openEdit(container, 'provider')
    const keyInput = dialog.querySelector('#endpoint-key') as HTMLInputElement
    expect(keyInput).toBeTruthy()
    expect(keyInput.type).toBe('password')
    // The key is an input, never a stored field: an endpoint that HAS a key
    // opens with an empty key field, and the hint says blank keeps it.
    expect(keyInput.value).toBe('')
    expect(dialog.textContent).toContain('Leave blank to keep the saved key')
  })

  it('edits an endpoint through endpoints.update with the unchanged id', async () => {
    const { container, updateEndpoint } = mount([
      ep({ id: 'endpoint:custom:provider:1', name: 'provider' }),
    ])
    await waitForRows(container, 1)

    const dialog = openEdit(container, 'provider')
    fillField(container, 'endpoint-name', 'Renamed provider')
    clickButton(dialog, 'Save Endpoint')

    await vi.waitFor(() => {
      expect(updateEndpoint).toHaveBeenCalledTimes(1)
    })
    const [id, input] = updateEndpoint.mock.calls[0]
    expect(id).toBe('endpoint:custom:provider:1')
    expect(input.name).toBe('Renamed provider')
    // An empty key on update means "keep the existing material" (design
    // §4.5.4) — the surface sends '', never a fabricated value.
    expect(input.key).toBe('')

    await vi.waitFor(() => {
      expect(rows(container)[0].textContent).toContain('Renamed provider')
    })
    expect(toastMessages()).toContain('Saved "Renamed provider"')
  })

  it('deletes an endpoint only after the confirm, through endpoints.delete', async () => {
    const { container, deleteEndpoint } = mount([
      ep({ id: 'endpoint:custom:provider:1', name: 'provider' }),
    ])
    await waitForRows(container, 1)

    const del = container.querySelector(
      '.ui-collection-row__actions [aria-label="Delete provider"]',
    )
    expect(del).toBeTruthy()
    fireEvent.click(del!)

    // Confirm dialog: the delete must not have happened yet.
    const confirm = findConfirmDialog('Delete "provider"?')
    expect(confirm, 'confirm dialog did not open').toBeTruthy()
    expect(deleteEndpoint).not.toHaveBeenCalled()

    clickButton(confirm!, 'OK', confirm!)
    await vi.waitFor(() => {
      expect(deleteEndpoint).toHaveBeenCalledWith('endpoint:custom:provider:1')
    })
    await waitForRows(container, 0)
    expect(toastMessages()).toContain('Deleted "provider"')
  })

  it('refuses a submit with nothing filled: per-field message, focus, no wire call', async () => {
    const { container, createEndpoint } = mount()
    await waitForRows(container, 0)

    const dialog = openNew(container)
    clickButton(dialog, 'Create Endpoint')

    // The kit gate announces the first failing rule with the count and
    // focuses the first offender; nothing reaches the wire. The gate is
    // async — the toast and the focus land on a microtask after the click.
    expect(createEndpoint).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(toastMessages()).toContain('Name is required — 3 fields need attention')
    })
    expect(document.activeElement?.id).toBe('endpoint-name')
    const nameError = dialog.querySelector('#endpoint-name__error')
    expect(nameError?.textContent).toBe('Name is required')
  })

  it('requires a model: no rows is refused, an empty model row is refused and focused', async () => {
    const { container, createEndpoint } = mount()
    await waitForRows(container, 0)

    const dialog = openNew(container)
    fillField(container, 'endpoint-name', 'provider')
    fillField(container, 'endpoint-base-url', 'https://api.example.com/v1')
    clickButton(dialog, 'Create Endpoint')

    expect(createEndpoint).not.toHaveBeenCalled()
    // No rows: no control to focus — the gate says so honestly.
    await vi.waitFor(() => {
      expect(toastMessages()).toContain('Add at least one model — could not focus the first field')
    })
    // The group error is on the surface too, through the kit's field-error
    // identity inside the list — one error vocabulary, exact message.
    const groupError = dialog.querySelector('.ui-row-list .ui-field-error')
    expect(groupError?.textContent).toBe('Add at least one model')

    clickButton(dialog, 'Add model')
    clickButton(dialog, 'Create Endpoint')
    expect(createEndpoint).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(toastMessages()).toContain('Model name is required')
    })
    expect(document.activeElement?.id).toBe('endpoint-model-0-name')

    fillField(container, 'endpoint-model-0-name', 'gpt-4o')
    clickButton(dialog, 'Create Endpoint')
    await vi.waitFor(() => {
      expect(createEndpoint).toHaveBeenCalledTimes(1)
    })
  })

  it('refuses a base URL that is not an absolute http(s) URL and focuses it', async () => {
    const { container, createEndpoint } = mount()
    await waitForRows(container, 0)

    const dialog = openNew(container)
    fillField(container, 'endpoint-name', 'provider')
    fillField(container, 'endpoint-base-url', 'not a url')
    clickButton(dialog, 'Add model')
    fillField(container, 'endpoint-model-0-name', 'gpt-4o')
    clickButton(dialog, 'Create Endpoint')

    expect(createEndpoint).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(toastMessages()).toContain('Must be an absolute http(s) URL')
    })
    expect(document.activeElement?.id).toBe('endpoint-base-url')
  })

  it('says a backend refusal on the surface — the vault sealed, the store refused', async () => {
    const { container, createEndpoint } = mount()
    await waitForRows(container, 0)
    createEndpoint.mockRejectedValueOnce(
      new RpcError('vault is sealed', -32001, { reason: 'vault-sealed' }),
    )

    const dialog = openNew(container)
    fillField(container, 'endpoint-name', 'provider')
    fillField(container, 'endpoint-base-url', 'https://api.example.com/v1')
    clickButton(dialog, 'Add model')
    fillField(container, 'endpoint-model-0-name', 'gpt-4o')
    clickButton(dialog, 'Create Endpoint')

    await vi.waitFor(() => {
      expect(toastMessages()).toContain('Could not save the endpoint: vault is sealed')
    })
    // The dialog stays open — the user can fix what the backend refused.
    expect(findDialogByTitle(container, 'New Endpoint')).toBeTruthy()
  })
  it('tests the draft through the Test button and shows the streaming verdict', async () => {
    const { container, probeEndpoint } = mount()
    await waitForRows(container, 0)

    const dialog = openNew(container)
    // The Test button exists but is inert until the probe means something.
    const btn = Array.from(dialog.querySelectorAll('.ui-button')).find((b) =>
      b.textContent?.includes('Test endpoint'),
    )
    expect(btn, 'Test endpoint button not found').toBeTruthy()
    expect((btn as HTMLButtonElement).disabled).toBe(true)

    fillField(container, 'endpoint-name', 'Local')
    fillField(container, 'endpoint-base-url', 'http://127.0.0.1:11434/v1')
    clickButton(dialog, 'Add model')
    fillField(container, 'endpoint-model-0-name', 'qwen3')
    expect((btn as HTMLButtonElement).disabled).toBe(false)

    clickButton(dialog, 'Test endpoint')

    await vi.waitFor(() => {
      expect(probeEndpoint).toHaveBeenCalledTimes(1)
    })
    expect(probeEndpoint.mock.calls[0][0]).toEqual({
      name: 'Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      key: '',
      model: 'qwen3',
    })
    await vi.waitFor(() => {
      expect(dialog.textContent).toContain('Streamed an answer in')
    })
  })

  it('tests a SAVED endpoint by naming it — the key stays blank and the backend resolves the stored credential', async () => {
    const { container, probeEndpoint } = mount([
      ep({
        id: 'endpoint:custom:provider:1',
        name: 'provider',
        baseUrl: 'https://api.example.com/v1',
        credential: 'secrow:0123456789abcdef',
        models: [{ name: 'gpt-4o', alias: null }],
      }),
    ])
    await waitForRows(container, 1)

    const dialog = openEdit(container, 'provider')
    // The key field is never pre-filled (ADR-0030 §3) — the record cannot
    // be read back, and an empty key means "keep the existing material".
    const keyInput = dialog.querySelector('#endpoint-key') as HTMLInputElement
    expect(keyInput.value).toBe('')

    clickButton(dialog, 'Test endpoint')

    await vi.waitFor(() => {
      expect(probeEndpoint).toHaveBeenCalledTimes(1)
    })
    // The probe NAMES the record and lets the backend resolve its
    // credential — exactly how connections.test names a profile. The key
    // never crosses the wire in the direction the renderer could have sent
    // it (it has none), and it must not be re-fetched here either.
    expect(probeEndpoint.mock.calls[0][0]).toEqual({
      name: 'provider',
      baseUrl: 'https://api.example.com/v1',
      key: '',
      model: 'gpt-4o',
      endpointId: 'endpoint:custom:provider:1',
    })
    await vi.waitFor(() => {
      expect(dialog.textContent).toContain('Streamed an answer in')
    })
  })

  it('shows a failed probe as a result, not a crash', async () => {
    const { container, probeEndpoint } = mount()
    await waitForRows(container, 0)
    // The probe contract: a failed dial is a RESULT with ok:false, never
    // an RPC error (the engine returns outcomes, not exceptions).
    probeEndpoint.mockResolvedValueOnce({
      name: 'Local',
      model: 'qwen3',
      ok: false,
      error: 'dial tcp: connection refused',
      elapsedMs: 0,
      at: new Date().toISOString(),
    })

    const dialog = openNew(container)
    fillField(container, 'endpoint-name', 'Local')
    fillField(container, 'endpoint-base-url', 'http://127.0.0.1:1/v1')
    clickButton(dialog, 'Add model')
    fillField(container, 'endpoint-model-0-name', 'qwen3')
    clickButton(dialog, 'Test endpoint')

    await vi.waitFor(() => {
      expect(dialog.textContent).toContain('Test failed: dial tcp: connection refused')
    })
  })

  it('leaves the no-endpoint sentence to the empty state, which carries the action', async () => {
    const { container } = mountWithAgent({
      endpointConfigured: false,
      credentialResolvable: false,
      lastProbe: null,
    })
    await vi.waitFor(() => {
      expect(container.textContent).toContain('No endpoints yet')
    })
    // One fact, one sentence: the readiness badge would only repeat what the
    // empty state says, without the button that fixes it.
    expect(container.querySelector('.ep-status-row')).toBeNull()
    expect(container.textContent).not.toContain('No endpoint configured yet')
  })

  it('shows the last probe outcome in the readiness line', async () => {
    const { container } = mountWithAgent(
      {
        endpointConfigured: true,
        credentialResolvable: true,
        lastProbe: {
          name: 'Local',
          model: 'qwen3',
          ok: true,
          elapsedMs: 42,
          at: new Date().toISOString(),
        },
      },
      [ep({ name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1' })],
    )
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Last test ok (qwen3)')
    })
  })

  it('names an unresolvable credential in the readiness line', async () => {
    const { container } = mountWithAgent({
      endpointConfigured: true,
      credentialResolvable: false,
      lastProbe: null,
    })
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Credential unavailable')
    })
  })

  it('says a failed list load on the surface and retries from there', async () => {
    const { container, listEndpoints } = mount(
      [ep({ id: 'endpoint:custom:provider:1', name: 'provider' })],
      { firstListError: new RpcError('endpoints not available', -32601) },
    )

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Couldn't load endpoints")
    })
    expect(container.textContent).toContain('endpoints not available')

    clickButton(container, 'Retry')
    await waitForRows(container, 1)
    expect(listEndpoints).toHaveBeenCalledTimes(2)
  })
})

describe('the vault seam — a key is minted through the vault layer (nocx-8rwj)', () => {
  /** Fill a valid new-endpoint form (with a key) and return its dialog. */
  function fillNewWithKey(container: HTMLElement) {
    const dialog = openNew(container)
    fillField(container, 'endpoint-name', 'provider')
    fillField(container, 'endpoint-base-url', 'https://api.example.com/v1')
    fillField(container, 'endpoint-key', 'sk-live-abc')
    clickButton(dialog, 'Add model')
    fillField(container, 'endpoint-model-0-name', 'gpt-4o')
    return dialog
  }

  it('raises the setup sheet on a first run, then saves the endpoint the person typed', async () => {
    const { container, createEndpoint, ctrl } = mountWithVault()
    await waitForRows(container, 0)
    // The wire refuses: the backend mints the key into the vault BEFORE it
    // writes the record (capability/config.go CreateEndpoint), so the
    // refusal is atomic — nothing was stored, and the error carries the
    // vault reason saveSecretWithVault recognizes.
    createEndpoint.mockRejectedValueOnce(
      new RpcError('vault is not initialized', -32603, { reason: 'vault-uninitialized' }),
    )

    fillNewWithKey(container)
    clickButton(container, 'Create Endpoint')

    // The first attempt hit the missing vault; the vault layer's own setup
    // sheet is up (the nocx-v64o behavior), nothing was stored or toasted.
    await vi.waitFor(() => {
      expect(ctrl.showSetup()).toBe(true)
    })
    expect(createEndpoint).toHaveBeenCalledTimes(1)
    expect(toastMessages()).not.toContain('Could not save the endpoint:')
    expect(findDialogByTitle(container, 'New Endpoint')).toBeTruthy()

    // Setup completes (the SetupDialog's Done → onSetupComplete →
    // onSetupDone): the EXACT save is retried and the endpoint appears.
    ctrl.onSetupDone()
    await vi.waitFor(() => {
      expect(createEndpoint).toHaveBeenCalledTimes(2)
    })
    expect(createEndpoint.mock.calls[1][0].key).toBe('sk-live-abc')
    await waitForRows(container, 1)
    expect(rows(container)[0].textContent).toContain('provider')
    await vi.waitFor(() => {
      expect(toastMessages()).toContain('Saved "provider"')
    })
    // The editor closed (the dialog stays mounted in the DOM, hidden).
    const closed = findDialogByTitle(container, 'New Endpoint')
    expect(closed).toBeTruthy()
    expect((closed as HTMLDialogElement).open).toBe(false)
  })

  it('a cancelled setup leaves the editor open with the draft intact and nothing stored', async () => {
    const { container, createEndpoint, setup, ctrl } = mountWithVault()
    await waitForRows(container, 0)
    createEndpoint.mockRejectedValueOnce(
      new RpcError('vault is not initialized', -32603, { reason: 'vault-uninitialized' }),
    )

    const dialog = fillNewWithKey(container)
    clickButton(container, 'Create Endpoint')

    await vi.waitFor(() => {
      expect(ctrl.showSetup()).toBe(true)
    })

    // The person closes the setup sheet without setting protection up.
    ctrl.closeSetup()
    await flush()

    // What is on screen: the editor, still open, with everything they typed.
    expect(findDialogByTitle(container, 'New Endpoint')).toBeTruthy()
    expect((dialog.querySelector('#endpoint-name') as HTMLInputElement).value).toBe('provider')
    expect((dialog.querySelector('#endpoint-base-url') as HTMLInputElement).value).toBe(
      'https://api.example.com/v1',
    )
    expect((dialog.querySelector('#endpoint-key') as HTMLInputElement).value).toBe('sk-live-abc')
    // What is in the vault: nothing — setup never ran.
    expect(setup).not.toHaveBeenCalled()
    // What is on the wire: one refused attempt, no silent retry.
    expect(createEndpoint).toHaveBeenCalledTimes(1)
    // Nothing reported saved, and no new failure toast either — a cancelled
    // setup is not an error the endpoint form must shout about.
    expect(toastMessages()).not.toContain('Saved "provider"')
    expect(toastMessages()).not.toContain('Could not save the endpoint:')
  })

  it('a failed setup stays in the setup sheet; the save resumes only after it succeeds', async () => {
    const { container, createEndpoint, setup, ctrl } = mountWithVault()
    await waitForRows(container, 0)
    createEndpoint.mockRejectedValueOnce(
      new RpcError('vault is not initialized', -32603, { reason: 'vault-uninitialized' }),
    )

    fillNewWithKey(container)
    clickButton(container, 'Create Endpoint')
    await vi.waitFor(() => {
      expect(ctrl.showSetup()).toBe(true)
    })

    // The backend refuses the setup (a dead store, a keychain error): the
    // setup sheet says so inline and stays up; the endpoint save is not
    // retried and nothing is toasted by the endpoint form.
    setup.mockRejectedValueOnce(new Error('Backend refused'))
    fillField(container, 'vault-setup-passphrase', 'correct horse')
    fillField(container, 'vault-setup-confirm', 'correct horse')
    clickButton(container, 'Set Up')
    await vi.waitFor(() => {
      const err = container.querySelector('#vault-setup-passphrase__error')
      expect(err?.textContent).toBe('Backend refused')
    })
    expect(createEndpoint).toHaveBeenCalledTimes(1)
    expect(toastMessages()).not.toContain('Could not save the endpoint:')

    // The person retries and this time the setup completes with a recovery
    // code; Done dismisses it and the deferred save lands.
    setup.mockResolvedValueOnce({ recoveryCode: 'ABCD-1234-EFGH-5678' })
    clickButton(container, 'Set Up')
    await vi.waitFor(() => {
      expect(findDialogByTitle(container, 'Recovery Code')).toBeTruthy()
    })
    clickButton(container, 'Done')
    await vi.waitFor(() => {
      expect(createEndpoint).toHaveBeenCalledTimes(2)
    })
    await waitForRows(container, 1)
    expect(rows(container)[0].textContent).toContain('provider')
    expect(createEndpoint.mock.calls[1][0].key).toBe('sk-live-abc')
  })

  it('a new key on an edit rotates through the same seam, keeping the id', async () => {
    const { container, updateEndpoint, ctrl } = mountWithVault([
      ep({ id: 'endpoint:custom:provider:1', name: 'provider' }),
    ])
    await waitForRows(container, 1)
    updateEndpoint.mockRejectedValueOnce(
      new RpcError('vault is not initialized', -32603, { reason: 'vault-uninitialized' }),
    )

    const dialog = openEdit(container, 'provider')
    fillField(container, 'endpoint-key', 'sk-rotated')
    clickButton(dialog, 'Save Endpoint')

    await vi.waitFor(() => {
      expect(ctrl.showSetup()).toBe(true)
    })
    expect(updateEndpoint).toHaveBeenCalledTimes(1)

    ctrl.onSetupDone()
    await vi.waitFor(() => {
      expect(updateEndpoint).toHaveBeenCalledTimes(2)
    })
    const [id, input] = updateEndpoint.mock.calls[1]
    expect(id).toBe('endpoint:custom:provider:1')
    expect(input.key).toBe('sk-rotated')
    await vi.waitFor(() => {
      expect(toastMessages()).toContain('Saved "provider"')
    })
  })

  it('a sealed vault raises the unlock sheet naming the operation, and resumes after unseal', async () => {
    const { container, createEndpoint, status, ctrl } = mountWithVault()
    status.mockResolvedValue({
      state: 'sealed' as const,
      osKeyAvailable: false,
      osKeyCapable: false,
      hasPassphrase: true,
      autoSealMinutes: 0,
      providers: [],
      defaultProvider: null,
    })
    await waitForRows(container, 0)
    createEndpoint.mockRejectedValueOnce(
      new RpcError('vault is sealed', -32603, { reason: 'vault-sealed' }),
    )

    fillNewWithKey(container)
    clickButton(container, 'Create Endpoint')

    await vi.waitFor(() => {
      expect(ctrl.showUnlock()).toBe(true)
    })
    // The unlock prompt must say WHICH operation needs the vault open and
    // why now (nocx-s8jn) — the reason the endpoint save passed along.
    expect(ctrl.unlockReason()).toBe('save this endpoint key')
    expect(createEndpoint).toHaveBeenCalledTimes(1)

    ctrl.onUnsealDone()
    await vi.waitFor(() => {
      expect(createEndpoint).toHaveBeenCalledTimes(2)
    })
    await waitForRows(container, 1)
    expect(rows(container)[0].textContent).toContain('provider')
  })

  it('a save with no key never touches the vault seam', async () => {
    const { container, createEndpoint, ctrl } = mountWithVault()
    await waitForRows(container, 0)

    const dialog = openNew(container)
    fillField(container, 'endpoint-name', 'provider')
    fillField(container, 'endpoint-base-url', 'https://api.example.com/v1')
    clickButton(dialog, 'Add model')
    fillField(container, 'endpoint-model-0-name', 'gpt-4o')
    clickButton(dialog, 'Create Endpoint')

    await vi.waitFor(() => {
      expect(createEndpoint).toHaveBeenCalledTimes(1)
    })
    // No key on the wire means no secret minted: the vault is not a party,
    // so no sheet and no deferred save.
    expect(ctrl.showSetup()).toBe(false)
    expect(ctrl.showUnlock()).toBe(false)
    await waitForRows(container, 1)
  })
})
