// @vitest-environment jsdom
/**
 * AgentApprovalPrompt tests — the renderer half of an approval question
 * (nocx-z9hj4). What a user can do: see ONE kind of question whether the
 * risk was an effect coming in (a policy escalation) or a secret going out
 * (an egress finding), see the tool, the arguments and — for egress — what
 * was found and where, never the material itself; and decide.
 *
 * Since nocx-gycwo the decision has a WIDTH as well as a direction: a policy
 * question offers allow and deny at once, in this session and always, so the
 * place a person is asked is the place they can stop being asked. An egress
 * question keeps two answers, both `once` — "always send secrets to the model
 * provider" is not a standing decision to be made by a button sitting next to
 * five others.
 *
 * What the surface must not overstate (criterion 4): it says what approval
 * covers — this call has not run, and no call after it will — and does NOT
 * claim the domain is untouched.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, fireEvent } from '@solidjs/testing-library'
import { AgentApprovalPrompt } from './agent-approval-prompt'
import type { AgentApprovalRequested } from './generated/agent.approvalRequested'
import type { AgentApprove } from './generated/agent.approve'

const POLICY_ASK: AgentApprovalRequested = {
  runId: '7',
  attempt: 1,
  tool: 'files.read',
  callId: 'call_1',
  argHash: 'hash-a',
  arguments: '{"path":"/repo/a.txt"}',
  reason: 'policy',
  // The effect the gate decided on, sent by the backend (nocx-zd1vp). The
  // surface must never work it out from the tool name — that would be a rule
  // keyed by a tool name in everything but storage (ADR-0028 decision 4).
  effect: 'observe',
  resource: { kind: 'path', id: '/repo/a.txt' },
}

const EGRESS_ASK: AgentApprovalRequested = {
  ...POLICY_ASK,
  reason: 'egress',
  wasError: false,
  findings: [
    { source: 'known', secretName: 'github-token', start: 0, end: 5 },
    { source: 'heuristic', kind: 'openai-api-key', start: 11, end: 40 },
  ],
}

function renderPrompt(overrides?: Partial<Parameters<typeof AgentApprovalPrompt>[0]>) {
  const props = {
    open: true,
    ask: POLICY_ASK,
    busy: false,
    onDecide: vi.fn(),
    ...overrides,
  }
  const utils = render(() => <AgentApprovalPrompt {...props} />)
  return { ...utils, props }
}

/** A recorder for the seam the surface actually owns: direction and width. */
function recordDecisions() {
  const decisions: Array<[boolean, AgentApprove['scope']]> = []
  return {
    decisions,
    onDecide: (approved: boolean, scope: AgentApprove['scope']) =>
      decisions.push([approved, scope]),
  }
}

const SID = '9bb9a7602c27e8ba0741972c7049b54b'

describe('AgentApprovalPrompt — a session is named, never numbered (nocx-vnzek)', () => {
  afterEach(cleanup)

  const SESSION_ASK: AgentApprovalRequested = {
    ...POLICY_ASK,
    tool: 'readScreen',
    arguments: `{"sessionId":"${SID}"}`,
    resource: { kind: 'session', id: SID },
  }

  it("says which pane the call reaches, in the pane's own name", () => {
    const r = renderPrompt({
      ask: SESSION_ASK,
      sessionWhere: (id: string) => (id === SID ? { tab: 'home/dev', machine: '' } : null),
    })
    expect(r.getByText(/home\/dev/)).toBeTruthy()
  })

  it('leaves the proposed arguments verbatim — the blob is what the model asked for', () => {
    const { container } = renderPrompt({
      ask: SESSION_ASK,
      sessionWhere: () => ({ tab: 'home/dev', machine: '' }),
    })
    const code = container.querySelector('.ui-code-block')
    expect(code?.textContent).toBe(`{"sessionId":"${SID}"}`)
  })

  it('says nothing extra when no pane can name the session', () => {
    const r = renderPrompt({ ask: SESSION_ASK, sessionWhere: () => null })
    expect(r.queryByText(/This call reaches/)).toBeNull()
  })

  it('says nothing extra for a path — a path is the person’s own word', () => {
    const r = renderPrompt({
      ask: POLICY_ASK,
      sessionWhere: () => ({ tab: 'home/dev', machine: '' }),
    })
    expect(r.queryByText(/This call reaches/)).toBeNull()
  })
})

/**
 * What the person is actually deciding, in a sentence (nocx-njn8s).
 *
 * The prompt used to print `{"command": "df -h", "sessionId": "ab607…cf95"}`
 * and leave the person to parse it by eye — with the session id nocx-vnzek
 * took off the tool-call line still sitting inside the blob, and the MACHINE,
 * the fact that decides whether a destructive command lands on this laptop or
 * on a production host, never named at all.
 *
 * The rendering is friendly only when it can be exhaustive: `run` with
 * exactly the two arguments its schema declares. Anything else falls back to
 * the verbatim blob, because a sentence that silently drops an argument is
 * worse than a blob that shows it.
 */
describe('AgentApprovalPrompt — what the call does, where (nocx-njn8s)', () => {
  afterEach(cleanup)

  const RUN_ASK: AgentApprovalRequested = {
    ...POLICY_ASK,
    tool: 'run',
    effect: 'mutate-destructive',
    arguments: `{"command":"df -h","sessionId":"${SID}"}`,
    resource: { kind: 'session', id: SID },
  }

  const LOCAL = { tab: 'home/dev', machine: '' }

  it('reads as a sentence: the command, the machine and the tab', () => {
    const { container } = renderPrompt({ ask: RUN_ASK, sessionWhere: () => LOCAL })
    const text = container.textContent ?? ''
    expect(text).toContain('run this command')
    expect(text).toContain('this machine')
    expect(text).toContain('home/dev')
    // The command itself, verbatim and alone — not wrapped in JSON.
    expect(container.querySelector('.ui-code-block')?.textContent).toBe('df -h')
  })

  it('never prints the session id back, on any surface of the question', () => {
    const { container } = renderPrompt({ ask: RUN_ASK, sessionWhere: () => LOCAL })
    expect(container.textContent ?? '').not.toContain(SID)
  })

  it('names the machine the pane is actually talking to', () => {
    const { container } = renderPrompt({
      ask: RUN_ASK,
      sessionWhere: () => ({ tab: 'srv-01', machine: 'deploy@srv-01.example.com' }),
    })
    const text = container.textContent ?? ''
    expect(text).toContain('deploy@srv-01.example.com')
    // "this machine" would be a lie about where the command lands.
    expect(text).not.toContain('this machine')
  })

  it('says nothing about where when no pane holds the session, and still shows the command', () => {
    const { container } = renderPrompt({ ask: RUN_ASK, sessionWhere: () => null })
    const text = container.textContent ?? ''
    expect(text).toContain('run this command')
    expect(text).not.toContain('in the tab')
    expect(text).not.toContain('this machine')
    expect(container.querySelector('.ui-code-block')?.textContent).toBe('df -h')
  })

  it('falls back to the verbatim blob when the proposal carries an argument it has no words for', () => {
    const args = `{"command":"df -h","sessionId":"${SID}","timeoutMs":5000}`
    const { container } = renderPrompt({
      ask: { ...RUN_ASK, arguments: args },
      sessionWhere: () => LOCAL,
    })
    expect(container.querySelector('.ui-code-block')?.textContent).toBe(args)
    expect(container.textContent ?? '').toContain('with these arguments')
  })

  it('falls back to the verbatim blob when the arguments are not an object at all', () => {
    const { container } = renderPrompt({
      ask: { ...RUN_ASK, arguments: 'not json' },
      sessionWhere: () => LOCAL,
    })
    expect(container.querySelector('.ui-code-block')?.textContent).toBe('not json')
  })

  it('names the machine on the location sentence of every other tool too', () => {
    const { container } = renderPrompt({
      ask: {
        ...POLICY_ASK,
        tool: 'readScreen',
        arguments: `{"sessionId":"${SID}"}`,
        resource: { kind: 'session', id: SID },
      },
      sessionWhere: () => ({ tab: 'srv-01', machine: 'deploy@srv-01.example.com' }),
    })
    const text = container.textContent ?? ''
    expect(text).toContain('This call reaches')
    expect(text).toContain('srv-01')
    expect(text).toContain('deploy@srv-01.example.com')
  })

  it('does not say the assistant WANTS to run a command that has already run', () => {
    // The egress gate screens a tool RESULT, so by the time this question is
    // asked the command is behind us and what is being decided is whether
    // what it printed may leave for the provider. "wants to run" there would
    // misreport what has already happened to the machine.
    const { container } = renderPrompt({
      ask: { ...RUN_ASK, reason: 'egress', wasError: false, findings: [] },
      sessionWhere: () => LOCAL,
    })
    const text = container.textContent ?? ''
    expect(text).not.toContain('wants to run')
    expect(text).toContain('The command that produced it ran')
    expect(container.querySelector('.ui-code-block')?.textContent).toBe('df -h')
  })

  it('says what the call can do, in the effect vocabulary and never from the tool name', () => {
    const { container } = renderPrompt({ ask: RUN_ASK, sessionWhere: () => LOCAL })
    expect(container.textContent ?? '').toContain('make changes that cannot be undone')
  })
})

describe('AgentApprovalPrompt', () => {
  afterEach(cleanup)

  it('names the tool, the arguments and the reason — the question a person decides', () => {
    const { container } = renderPrompt()
    expect(container.textContent).toContain('files.read')
    expect(container.textContent).toContain('{"path":"/repo/a.txt"}')
    expect(container.querySelector('.ui-prompt[data-placement="top-sheet"]')).toBeTruthy()
  })

  it('states what approval covers and does not claim the domain is untouched (criterion 4)', () => {
    const { container } = renderPrompt()
    const text = container.textContent ?? ''
    expect(text).toContain('it has not run')
    expect(text).toContain('no call after it in this response will')
    expect(text).toContain('does not promise the terminal is untouched')
  })

  it('renders egress findings — facts, never the material — and distinguishes the sources', () => {
    const { container } = renderPrompt({ ask: EGRESS_ASK })
    const text = container.textContent ?? ''
    expect(text).toContain('Nothing was sent to the model provider')
    expect(text).toContain('Known vault material')
    expect(text).toContain('github-token')
    expect(text).toContain('Heuristic match')
    expect(text).toContain('openai-api-key')
    // The secret VALUE is never on the surface: only facts about it.
    expect(text).not.toContain('sk-')
  })

  it('says when the findings are in an ERROR string rather than a result', () => {
    const { container } = renderPrompt({ ask: { ...EGRESS_ASK, wasError: true } })
    expect(container.textContent).toContain('The tool failed')
  })

  it('a policy question offers three allowances and three refusals, each with its scope', () => {
    const { decisions, onDecide } = recordDecisions()
    const ui = renderPrompt({ onDecide })

    for (const name of [
      'Allow once',
      'Allow in this session',
      'Allow always',
      'Deny once',
      'Deny in this session',
      'Deny always',
    ]) {
      fireEvent.click(ui.getByRole('button', { name }))
    }

    expect(decisions).toEqual([
      [true, 'once'],
      [true, 'session'],
      [true, 'always'],
      [false, 'once'],
      [false, 'session'],
      [false, 'always'],
    ])
  })

  it('groups the allowances apart from the refusals, and leads each group with once', () => {
    const { container } = renderPrompt()
    const groups = Array.from(container.querySelectorAll('.ui-action-group'))
    expect(groups).toHaveLength(2)
    const names = groups.map((g) =>
      Array.from(g.querySelectorAll('.ui-button')).map((b) => b.textContent),
    )
    expect(names).toEqual([
      ['Allow once', 'Allow in this session', 'Allow always'],
      ['Deny once', 'Deny in this session', 'Deny always'],
    ])
  })

  it("names the effect in the product's words, and reads it from effect and never from tool", () => {
    const { container } = renderPrompt()
    expect(container.textContent).toContain('read and inspect')

    cleanup()
    // Same tool name, a different effect: the words must follow `effect`.
    const { container: other } = renderPrompt({
      ask: { ...POLICY_ASK, effect: 'mutate-destructive' },
    })
    expect(other.textContent).toContain('make changes that cannot be undone')
    expect(other.textContent).not.toContain('read and inspect')
  })

  it('says how long a session answer lasts, and never promises the pane', () => {
    const { container } = renderPrompt()
    const text = container.textContent ?? ''
    expect(text).toContain('in this session')
    // The permission binds to the terminal SESSION: restarting the shell in
    // the same pane asks again, so naming the pane would promise a lifetime
    // the answer does not have.
    expect(text).not.toContain('in this pane')
    expect(text).toContain('Agent policy page')
  })

  it('an egress question offers two answers, and both are once', () => {
    const { decisions, onDecide } = recordDecisions()
    const ui = renderPrompt({ ask: EGRESS_ASK, onDecide })

    expect(ui.queryByRole('button', { name: 'Allow always' })).toBeNull()
    expect(ui.queryByRole('button', { name: 'Allow in this session' })).toBeNull()
    expect(ui.queryByRole('button', { name: 'Deny always' })).toBeNull()
    expect(ui.container.querySelectorAll('.ui-button')).toHaveLength(2)

    fireEvent.click(ui.getByRole('button', { name: 'Allow' }))
    fireEvent.click(ui.getByRole('button', { name: 'Deny' }))
    expect(decisions).toEqual([
      [true, 'once'],
      [false, 'once'],
    ])
  })

  it('dismissing the prompt is the NARROWEST refusal, never a standing one', () => {
    const { decisions, onDecide } = recordDecisions()
    const { container } = renderPrompt({ onDecide })
    const overlay = container.querySelector('.ui-prompt-overlay')!
    fireEvent.mouseDown(overlay)
    expect(decisions).toEqual([[false, 'once']])
  })

  it('disables every answer while the decision is in flight', () => {
    const { container } = renderPrompt({ busy: true })
    const buttons = Array.from(container.querySelectorAll('.ui-button'))
    expect(buttons).toHaveLength(6)
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true)
  })
})
