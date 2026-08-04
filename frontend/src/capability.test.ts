import { describe, it, expect } from 'vitest'
import { deriveActions, deriveShellState, type ActionFacts } from './capability'

const facts = (over: Partial<ActionFacts> = {}): ActionFacts => ({
  shellState: 'unsupported',
  presentation: 'terminal',
  delivery: 'launcher',
  authorized: false,
  eligible: false,
  ...over,
})

describe('three axes (nocx-atyf.1)', () => {
  it('a shell emitting markers while the user deliberately sits in terminal input — the combination the old single axis could not express', () => {
    // Old model: this was 'enhanced-input', which conflated "evidence
    // exists but nocx does not own the prompt" with "command is running"
    // and "alt-screen program owns the pane". In the new model these are
    // separate axes: the shell IS integrated AND the presentation IS
    // terminal — the user chose it.
    const state = deriveShellState({
      integrated: true,
      integrating: false,
      integrationFailed: false,
      trusted: true,
    })
    expect(state).toBe('integrated')

    // With authorisation and eligibility resolved, the user should be
    // offered a way back to the editor.
    const actions = deriveActions(
      facts({
        shellState: 'integrated',
        presentation: 'terminal',
        delivery: 'in-band',
        authorized: true,
        eligible: true,
      }),
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]).toEqual({ kind: 'enable-editor', label: 'Enable command editor' })
  })

  it('returns no actions when prerequisites are absent — never disabled-then-rejected', () => {
    // Not authorized: action is ABSENT, not disabled.
    expect(
      deriveActions(
        facts({
          shellState: 'unsupported',
          presentation: 'terminal',
          authorized: false,
          eligible: true,
        }),
      ),
    ).toHaveLength(0)

    // Not technically eligible: action is ABSENT.
    expect(
      deriveActions(
        facts({
          shellState: 'unsupported',
          presentation: 'terminal',
          authorized: true,
          eligible: false,
        }),
      ),
    ).toHaveLength(0)

    // Both absent: still absent.
    expect(
      deriveActions(facts({ shellState: 'unsupported', authorized: false, eligible: false })),
    ).toHaveLength(0)
  })

  it('the healthy state — integrated + editor — shows nothing', () => {
    expect(
      deriveActions(
        facts({
          shellState: 'integrated',
          presentation: 'editor',
          delivery: 'in-band',
          authorized: true,
          eligible: true,
        }),
      ),
    ).toHaveLength(0)
  })
})

describe('deriveShellState', () => {
  it('a plain shell with no markers is unsupported', () => {
    expect(
      deriveShellState({
        integrated: false,
        integrating: false,
        integrationFailed: false,
        trusted: false,
      }),
    ).toBe('unsupported')
  })

  it('a shell with markers and trust is integrated', () => {
    expect(
      deriveShellState({
        integrated: true,
        integrating: false,
        integrationFailed: false,
        trusted: true,
      }),
    ).toBe('integrated')
  })

  it('a shell whose markers stopped is lost', () => {
    expect(
      deriveShellState({
        integrated: true,
        integrating: false,
        integrationFailed: false,
        trusted: false,
      }),
    ).toBe('lost')
  })

  it('an in-flight integration is integrating', () => {
    expect(
      deriveShellState({
        integrated: false,
        integrating: true,
        integrationFailed: false,
        trusted: false,
      }),
    ).toBe('integrating')
  })

  it('a failed integration is failed', () => {
    expect(
      deriveShellState({
        integrated: false,
        integrating: false,
        integrationFailed: true,
        trusted: false,
      }),
    ).toBe('failed')
  })
})

describe('deriveActions per state', () => {
  const authorizedFacts = (over: Partial<ActionFacts> = {}): ActionFacts =>
    facts({ authorized: true, eligible: true, ...over })

  it('unsupported shell: offer integration', () => {
    const actions = deriveActions(authorizedFacts({ shellState: 'unsupported' }))
    expect(actions).toHaveLength(1)
    expect(actions[0].kind).toBe('integrate')
  })

  it('eligible shell: offer integration', () => {
    const actions = deriveActions(authorizedFacts({ shellState: 'eligible' }))
    expect(actions).toHaveLength(1)
    expect(actions[0].kind).toBe('integrate')
  })

  it('failed integration: offer retry', () => {
    const actions = deriveActions(authorizedFacts({ shellState: 'failed' }))
    expect(actions).toHaveLength(1)
    expect(actions[0].kind).toBe('retry-integration')
  })

  it('integrated + terminal: offer enable-editor', () => {
    const actions = deriveActions(
      authorizedFacts({ shellState: 'integrated', presentation: 'terminal' }),
    )
    expect(actions).toHaveLength(1)
    expect(actions[0].kind).toBe('enable-editor')
  })

  it('integrated + editor: no actions (healthy)', () => {
    const actions = deriveActions(
      authorizedFacts({ shellState: 'integrated', presentation: 'editor' }),
    )
    expect(actions).toHaveLength(0)
  })

  it('lost: offer restore', () => {
    const actions = deriveActions(authorizedFacts({ shellState: 'lost' }))
    expect(actions).toHaveLength(1)
    expect(actions[0].kind).toBe('restore-editor')
  })
})
