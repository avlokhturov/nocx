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
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, fireEvent } from '@solidjs/testing-library'
import { EndpointsSection } from './endpoints-section'
import { EndpointClient, type Endpoint, type EndpointWrite } from './endpoints'
import { AgentClient } from './agent'
import type { AgentStatusResult } from './generated/agent.status'
import { Dispatcher, RpcError } from './dispatcher'
import { clearToasts, toasts } from './ui'

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

function mount(initial: Endpoint[] = [], opts?: { firstListError?: Error }) {
  const harness = createHarness(initial, opts)
  const container = document.body.appendChild(document.createElement('div'))
  render(() => <EndpointsSection client={harness.client} />, { container })
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

describe('AI endpoints surface — real surface, real client seam', () => {
  it('adds an endpoint end to end: the button, the fields, the wire, the list', async () => {
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

  it('shows the assistant readiness line from agent.status', async () => {
    const { container } = mountWithAgent({
      endpointConfigured: false,
      credentialResolvable: false,
      lastProbe: null,
    })
    await vi.waitFor(() => {
      expect(container.textContent).toContain('No endpoint configured yet')
    })
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
