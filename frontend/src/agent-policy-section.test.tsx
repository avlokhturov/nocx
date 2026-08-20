// @vitest-environment jsdom
/**
 * User-path tests for the agent policy surface (ADR-0020 §7 as amended,
 * amendment proposed/awaiting owner approval): a person loads the matrix,
 * changes a decision per effect, adds a scope, saves, and the save surfaces
 * a refusal. The tool-name rule is asserted here too, at the vocabulary this
 * page speaks: the kind select offers no 'tool' option, so the surface
 * cannot express a rule over a tool name.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, fireEvent, within } from '@solidjs/testing-library'
import { Dispatcher } from './dispatcher'
import { PolicyClient, type PolicyMatrix } from './policy-client'
import { AgentPolicySection } from './agent-policy-section'
import { clearToasts, toasts } from './ui'

const LOADED: PolicyMatrix = {
  observe: { decision: 'permit', scopes: [{ kind: 'path', id: '/workspace' }] },
  'mutate-reversible': { decision: 'ask', scopes: [] },
  'mutate-destructive': { decision: 'refuse', scopes: [] },
  'privilege-change': { decision: 'ask', scopes: [] },
  disclose: { decision: 'ask', scopes: [] },
  'cross-boundary': { decision: 'ask', scopes: [] },
  delegate: { decision: 'ask', scopes: [] },
}

afterEach(() => {
  cleanup()
  clearToasts()
})

function mount(client: PolicyClient): HTMLElement {
  const container = document.body.appendChild(document.createElement('div'))
  render(() => <AgentPolicySection client={client} />, { container })
  return container
}

function mockedClient(overrides?: { get?: PolicyMatrix; setError?: Error }): PolicyClient {
  const client = new PolicyClient(new Dispatcher())
  if (overrides?.get) {
    vi.spyOn(client, 'get').mockResolvedValue(overrides.get)
  }
  if (overrides?.setError) {
    vi.spyOn(client, 'set').mockRejectedValue(overrides.setError)
  }
  return client
}

describe('agent policy surface', () => {
  // THE ROW IS THREE COLUMNS AND THE SCOPES ARE ONE OF THEM (nocx-c72pl).
  // Emitted as direct children of the grid, the second scope wrapped into the
  // next grid row's FIRST column — the 12rem effect-label column — so it
  // rendered visibly narrower than the first and read as though it belonged
  // to a different effect. The scopes and their add control are one group and
  // must share one cell, so the assertion is structural: every scope of a row
  // has the same parent, and that parent is not the row itself.
  it('keeps every scope of a row in one container, not spread across grid cells', async () => {
    const twoScopes: PolicyMatrix = {
      ...LOADED,
      observe: {
        decision: 'permit',
        scopes: [
          { kind: 'path', id: '/workspace' },
          { kind: 'path', id: '/srv' },
        ],
      },
    }
    const client = mockedClient({ get: twoScopes })
    const container = mount(client)
    const row = container.querySelector('[data-effect="observe"]') as HTMLElement
    await vi.waitFor(() => {
      expect(row.querySelectorAll('.st-policy__scope')).toHaveLength(2)
    })
    const scopes = Array.from(row.querySelectorAll('.st-policy__scope'))
    const parents = new Set(scopes.map((s) => s.parentElement))
    expect(parents.size).toBe(1)
    expect(scopes[0].parentElement).not.toBe(row)
  })

  it('renders the seven effect rows from the wire', async () => {
    const client = mockedClient({ get: LOADED })
    const container = mount(client)
    const row = container.querySelector('[data-effect="observe"]') as HTMLElement
    expect(row).not.toBeNull()
    await vi.waitFor(() => {
      const select = row.querySelector('select') as HTMLSelectElement
      expect(select.value).toBe('permit')
    })
    expect(within(row).getByDisplayValue('/workspace')).not.toBeNull()
    // The matrix is exactly seven rows.
    expect(container.querySelectorAll('[data-effect]')).toHaveLength(7)
  })

  it('changes a decision and saves the matrix', async () => {
    const client = new PolicyClient(new Dispatcher())
    vi.spyOn(client, 'get').mockResolvedValue(LOADED)
    const setSpy = vi.spyOn(client, 'set').mockResolvedValue({ ok: true })
    const container = mount(client)

    const observe = container.querySelector('[data-effect="observe"]') as HTMLElement
    await vi.waitFor(() => {
      expect((observe.querySelector('select') as HTMLSelectElement).value).toBe('permit')
    })
    fireEvent.change(observe.querySelector('select') as HTMLSelectElement, {
      target: { value: 'refuse' },
    })

    fireEvent.click(within(container).getByRole('button', { name: 'Save policy' }))
    await vi.waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1))
    const sent = setSpy.mock.calls[0][0]
    expect(sent.observe.decision).toBe('refuse')
    expect(sent.observe.scopes).toEqual([{ kind: 'path', id: '/workspace' }])
    expect(sent['mutate-destructive'].decision).toBe('refuse')
  })

  it('adds and removes a scope on a row', async () => {
    const client = new PolicyClient(new Dispatcher())
    vi.spyOn(client, 'get').mockResolvedValue(LOADED)
    const setSpy = vi.spyOn(client, 'set').mockResolvedValue({ ok: true })
    const container = mount(client)

    const observe = container.querySelector('[data-effect="observe"]') as HTMLElement
    await vi.waitFor(() => {
      expect(within(observe).queryByDisplayValue('/workspace')).not.toBeNull()
    })
    fireEvent.click(within(observe).getByRole('button', { name: 'Scope' }))
    const idInputs = within(observe).getAllByRole('textbox')
    expect(idInputs).toHaveLength(2) // the loaded one plus the new blank one
    fireEvent.input(idInputs[1], { target: { value: '/docs' } })

    fireEvent.click(within(container).getByRole('button', { name: 'Save policy' }))
    await vi.waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1))
    const sent = setSpy.mock.calls[0][0]
    expect(sent.observe.scopes).toEqual([
      { kind: 'path', id: '/workspace' },
      { kind: 'path', id: '/docs' },
    ])
  })

  it('offers no tool scope kind — the grant never names tools', async () => {
    const client = new PolicyClient(new Dispatcher())
    vi.spyOn(client, 'get').mockResolvedValue(LOADED)
    const container = mount(client)

    const observe = container.querySelector('[data-effect="observe"]') as HTMLElement
    await vi.waitFor(() => {
      expect(within(observe).queryByDisplayValue('/workspace')).not.toBeNull()
    })
    fireEvent.click(within(observe).getByRole('button', { name: 'Scope' }))
    const kindSelects = observe.querySelectorAll('select')
    const kinds = kindSelects[kindSelects.length - 1]
    const options = Array.from(kinds.querySelectorAll('option')).map((o) => o.value)
    expect(options).not.toContain('tool')
    expect(options).toContain('path')
  })

  it('surfaces a refused save as a danger toast', async () => {
    const client = new PolicyClient(new Dispatcher())
    vi.spyOn(client, 'get').mockResolvedValue(LOADED)
    vi.spyOn(client, 'set').mockRejectedValue(new Error('policy: unparseable'))
    const container = mount(client)

    await vi.waitFor(() => {
      expect(within(container).queryByDisplayValue('/workspace')).not.toBeNull()
    })
    fireEvent.click(within(container).getByRole('button', { name: 'Save policy' }))
    await vi.waitFor(() => {
      expect(toasts().some((t) => t.level === 'danger' && t.message.includes('not accepted'))).toBe(
        true,
      )
    })
  })
})
