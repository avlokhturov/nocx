// @vitest-environment jsdom
/**
 * Component-level acceptance for the model roles surface (nocx-e6kn2).
 *
 * Drives the real RolesSection the way a person drives it — the selects,
 * queried through the container exactly like the other section tests —
 * and asserts the product rules the bead names: every role of the closed
 * set is a visible row; an unassigned role is a visible warning, never
 * hidden; assigning a pair reaches roles.assign with exactly that pair;
 * choosing "— None —" clears; and the state sentence carries the same
 * meaning the ask transaction refuses on (deleted endpoint, removed model).
 */
import { describe, it, expect, vi, afterEach, type MockInstance } from 'vitest'
import { cleanup, render, fireEvent } from '@solidjs/testing-library'
import { RolesSection, roleStateLine } from './roles-section'
import { EndpointClient, type Endpoint, type RoleAssignInput } from './endpoints'
import { Dispatcher } from './dispatcher'
import { clearToasts } from './ui'
import type { Role } from './generated/roles.list'

afterEach(() => {
  clearToasts()
  vi.clearAllMocks()
  cleanup()
  document.body.innerHTML = ''
})

function ep(id: string, name: string, models: string[]): Endpoint {
  return {
    id,
    name,
    baseUrl: `https://${name}.example.com/v1`,
    schema: 'openai-compatible',
    credential: null,
    models: models.map((m) => ({ name: m, alias: null })),
    headers: [],
  }
}

function role(
  role: 'answering' | 'classifier',
  endpointId: string | null,
  model: string | null,
): Role {
  return { role, endpointId, model }
}

/** Mount the section and return the container plus the spied client. */
function mountRoles(
  endpoints: Endpoint[],
  roles: Role[],
): {
  client: EndpointClient
  assignRole: MockInstance<(input: RoleAssignInput) => Promise<Role[]>>
  container: HTMLElement
} {
  const client = new EndpointClient(new Dispatcher())
  const assignRole = vi
    .spyOn(client, 'assignRole')
    .mockImplementation((input) =>
      Promise.resolve(
        [...roles].map((r) =>
          r.role === input.role ? { ...r, endpointId: input.endpointId, model: input.model } : r,
        ),
      ),
    )
  vi.spyOn(client, 'listRoles').mockImplementation(() => Promise.resolve([...roles]))
  vi.spyOn(client, 'listEndpoints').mockImplementation(() => Promise.resolve([...endpoints]))
  const container = document.body.appendChild(document.createElement('div'))
  render(() => <RolesSection client={client} />, { container })
  return { client, assignRole, container }
}

function roleRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.roles-role'))
}

/** The endpoint select and the model select of one role row. */
function selects(row: HTMLElement): [HTMLSelectElement, HTMLSelectElement] {
  const els = row.querySelectorAll<HTMLSelectElement>('select')
  if (els.length !== 2) throw new Error(`expected 2 selects, got ${els.length}`)
  return [els[0], els[1]]
}

function text(row: HTMLElement): string {
  return row.textContent ?? ''
}

describe('the closed role set is visible', () => {
  it('renders every role of the wire as a row — an unassigned role is a row, never absent', async () => {
    const { container } = mountRoles(
      [],
      [role('answering', null, null), role('classifier', null, null)],
    )
    await vi.waitFor(() => {
      expect(roleRows(container).length).toBe(2)
    })
    expect(text(roleRows(container)[0])).toContain('Answering')
    expect(text(roleRows(container)[1])).toContain('Classifier')
  })

  it('an unassigned role next to working endpoints shows the no-model warning', async () => {
    const { container } = mountRoles(
      [ep('e1', 'OpenAI', ['gpt-4o'])],
      [role('answering', null, null), role('classifier', null, null)],
    )
    await vi.waitFor(() => {
      expect(roleRows(container).length).toBe(2)
    })
    expect(text(roleRows(container)[0])).toMatch(/No model assigned/)
  })
})

describe('roleStateLine — the sentence the row and the backend share', () => {
  const eps = [ep('e1', 'OpenAI', ['gpt-4o', 'gpt-4o-mini']), ep('e2', 'Local', ['qwen3'])]

  it('names the assigned endpoint and model', () => {
    const line = roleStateLine(role('answering', 'e2', 'qwen3'), eps)
    expect(line.tone).toBe('ok')
    expect(line.text).toContain('Local')
    expect(line.text).toContain('qwen3')
  })

  it('an unassigned role is a warning, never ok — the visible failure the ask refuses on', () => {
    const line = roleStateLine(role('answering', null, null), eps)
    expect(line.tone).toBe('warning')
  })

  it('a deleted endpoint is an error that says so — never a hop to a neighbour', () => {
    const line = roleStateLine(role('answering', 'e9-gone', 'gpt-4o'), eps)
    expect(line.tone).toBe('error')
    expect(line.text).toMatch(/endpoint.*no longer exists/)
  })

  it('a removed model is an error that names the model and the endpoint', () => {
    const line = roleStateLine(role('classifier', 'e2', 'gpt-4o'), eps)
    expect(line.tone).toBe('error')
    expect(line.text).toContain('gpt-4o')
    expect(line.text).toContain('Local')
  })
})

describe('assigning a model to a role in the product', () => {
  it('picking an endpoint then a model reaches roles.assign with EXACTLY that pair — and never a half-pair', async () => {
    const eps = [ep('e1', 'OpenAI', ['gpt-4o']), ep('e2', 'Local', ['qwen3'])]
    const roles = [role('answering', null, null), role('classifier', null, null)]
    const { container, assignRole } = mountRoles(eps, roles)
    await vi.waitFor(() => expect(roleRows(container).length).toBe(2))

    const [endpointSelect, modelSelect] = selects(roleRows(container)[0])
    fireEvent.change(endpointSelect, { target: { value: 'e2' } })
    // The model select offers the chosen endpoint's models.
    await vi.waitFor(() => {
      expect(Array.from(modelSelect.options).map((o) => o.value)).toContain('qwen3')
    })
    fireEvent.change(modelSelect, { target: { value: 'qwen3' } })

    await vi.waitFor(() => {
      expect(assignRole).toHaveBeenCalledWith({
        role: 'answering',
        endpointId: 'e2',
        model: 'qwen3',
      })
    })
    // Exactly ONE write: the half-pair (endpoint, no model) never went out.
    expect(assignRole).toHaveBeenCalledTimes(1)
  })

  it('the assigned state names the endpoint and model on the row', async () => {
    const eps = [ep('e1', 'OpenAI', ['gpt-4o'])]
    const { container } = mountRoles(eps, [
      role('answering', 'e1', 'gpt-4o'),
      role('classifier', null, null),
    ])
    await vi.waitFor(() => {
      expect(text(roleRows(container)[0])).toMatch(/Answers with OpenAI · gpt-4o/)
    })
  })

  it('choosing "— None —" on the endpoint clears the role', async () => {
    const eps = [ep('e1', 'OpenAI', ['gpt-4o'])]
    const roles = [role('answering', 'e1', 'gpt-4o'), role('classifier', null, null)]
    const { container, assignRole } = mountRoles(eps, roles)
    await vi.waitFor(() => {
      expect(text(roleRows(container)[0])).toMatch(/Answers with OpenAI/)
    })
    fireEvent.change(selects(roleRows(container)[0])[0], { target: { value: '' } })
    await vi.waitFor(() => {
      expect(assignRole).toHaveBeenCalledWith({ role: 'answering', endpointId: null, model: null })
    })
  })

  it('an assigned row whose endpoint was deleted renders the unresolvable error, and reassignment is possible', async () => {
    // The wire still carries the assignment; the endpoint list no longer
    // has it. The row must SAY so, and offer a working replacement.
    const eps = [ep('e2', 'Local', ['qwen3'])]
    const roles = [role('answering', 'e9-gone', 'gpt-4o'), role('classifier', null, null)]
    const { container, assignRole } = mountRoles(eps, roles)
    await vi.waitFor(() => {
      expect(text(roleRows(container)[0])).toMatch(/endpoint.*no longer exists/)
    })
    const [endpointSelect, modelSelect] = selects(roleRows(container)[0])
    // The model select offers only the placeholder until a replacement
    // endpoint is picked (the gone endpoint has no models to offer).
    expect(Array.from(modelSelect.options)).toHaveLength(1)
    fireEvent.change(endpointSelect, { target: { value: 'e2' } })
    await vi.waitFor(() => {
      expect(Array.from(modelSelect.options).map((o) => o.value)).toContain('qwen3')
    })
    fireEvent.change(modelSelect, { target: { value: 'qwen3' } })
    // The reassignment write carries the NEW pair, not the dangling one.
    await vi.waitFor(() => {
      expect(assignRole).toHaveBeenCalledWith({
        role: 'answering',
        endpointId: 'e2',
        model: 'qwen3',
      })
    })
  })
})
