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

/** What a pane answers about itself. `cwd`/`cwdVerified` travel together
 *  (nocx-n7xha): a cwd an OSC 7 report confirmed is a claim, the one a
 *  session was opened with is a guess, and this window is the one place a
 *  guess printed as fact costs most. */
type Where = { tab: string; machine: string; cwd: string; cwdVerified: boolean }

/** A local pane in a directory the shell has confirmed. */
const HERE: Where = { tab: 'home/dev', machine: '', cwd: '/home/dev', cwdVerified: true }

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
      sessionWhere: (id: string) => (id === SID ? HERE : null),
    })
    // The pane's own name, not the 32-hex handle the wire carried.
    expect(r.container.textContent ?? '').toContain('home/dev')
    expect(r.container.textContent ?? '').not.toContain(SID)
  })

  /**
   * CHANGED DELIBERATELY (nocx-n7xha). This used to assert the verbatim
   * blob — `{"sessionId":"9bb9a760…"}` — on the grounds that a paraphrase is
   * honest only while it is exhaustive, which is right and is not what
   * changed. What changed is the conclusion that exhaustive means per-tool:
   * a renderer listing EVERY parsed argument as a named row is exhaustive
   * by construction, so the blob is no longer the price of honesty here.
   * And for readScreen the blob's only content IS the id two beads took
   * off every other surface, so it added nothing to the sentence beneath
   * it while putting the id back on the one surface that asks a person to
   * decide.
   */
  it('renders the session argument as the pane, never as the id and never as a blob', () => {
    const { container } = renderPrompt({ ask: SESSION_ASK, sessionWhere: () => HERE })
    expect(container.querySelector('.ui-code-block')).toBeNull()
    const names = Array.from(container.querySelectorAll('.ui-fact-list__name')).map(
      (n) => n.textContent,
    )
    expect(names).toContain('sessionId')
    expect(container.textContent ?? '').toContain('home/dev on this machine')
    expect(container.textContent ?? '').not.toContain(SID)
  })

  it('still accounts for the session when no pane can name it — without the id', () => {
    const { container } = renderPrompt({ ask: SESSION_ASK, sessionWhere: () => null })
    const names = Array.from(container.querySelectorAll('.ui-fact-list__name')).map(
      (n) => n.textContent,
    )
    // Nothing is dropped: the argument is still a row. But an id nothing on
    // screen can name is still an id, so it stays off the surface.
    expect(names).toEqual(['sessionId'])
    expect(container.textContent ?? '').not.toContain(SID)
    expect(container.textContent ?? '').toContain('no tab in this window holds')
  })

  it('says nothing about a tab or a directory for a path — a path is the person’s own word', () => {
    const { container } = renderPrompt({ ask: POLICY_ASK, sessionWhere: () => HERE })
    const text = container.textContent ?? ''
    expect(text).not.toContain('home/dev')
    expect(text).not.toContain('working directory')
    // The path argument itself is still a row, named as the model named it.
    const rows = Array.from(container.querySelectorAll('.ui-fact-list__row')).map(
      (r) => r.textContent,
    )
    expect(rows).toEqual(['path/repo/a.txt'])
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

  const LOCAL: Where = HERE

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
      sessionWhere: () => ({
        tab: 'srv-01',
        machine: 'deploy@srv-01.example.com',
        cwd: '/srv/app',
        cwdVerified: true,
      }),
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

  /**
   * CHANGED DELIBERATELY (nocx-n7xha). njn8s put the blob back whenever
   * `run` carried a third argument, because the sentence had words for two
   * and dropping the third silently would have been worse than a blob. The
   * sentence is now accompanied by a row per argument it does not itself
   * state, so the third argument is SHOWN rather than dropped — which is
   * what the fallback was protecting, obtained without giving up the
   * sentence and without putting the session id back on screen.
   */
  it('shows an argument it has no words for as a row, and keeps the sentence', () => {
    const args = `{"command":"df -h","sessionId":"${SID}","timeoutMs":5000}`
    const { container } = renderPrompt({
      ask: { ...RUN_ASK, arguments: args },
      sessionWhere: () => LOCAL,
    })
    expect(container.querySelector('.ui-code-block')?.textContent).toBe('df -h')
    const rows = Array.from(container.querySelectorAll('.ui-fact-list__row')).map(
      (r) => r.textContent,
    )
    expect(rows).toContain('timeoutMs5000')
    expect(container.textContent ?? '').not.toContain(SID)
    expect(container.textContent ?? '').not.toContain('with these arguments')
  })

  it('falls back to the verbatim blob when the arguments are not an object at all', () => {
    const { container } = renderPrompt({
      ask: { ...RUN_ASK, arguments: 'not json' },
      sessionWhere: () => LOCAL,
    })
    expect(container.querySelector('.ui-code-block')?.textContent).toBe('not json')
  })

  it('names the machine for every other tool too — as the session row (nocx-n7xha)', () => {
    const { container } = renderPrompt({
      ask: {
        ...POLICY_ASK,
        tool: 'readScreen',
        arguments: `{"sessionId":"${SID}"}`,
        resource: { kind: 'session', id: SID },
      },
      sessionWhere: () => ({
        tab: 'srv-01',
        machine: 'deploy@srv-01.example.com',
        cwd: '/srv/app',
        cwdVerified: true,
      }),
    })
    // Where the call lands is stated ONCE. `run` states it in its lead
    // sentence; every other tool states it on the row for the argument
    // that names the session — never both, which would be two surfaces
    // owning one fact.
    expect(container.textContent ?? '').not.toContain('This call reaches')
    const rows = Array.from(container.querySelectorAll('.ui-fact-list__row')).map(
      (r) => r.textContent,
    )
    expect(rows[0]).toBe('sessionIdsrv-01 on deploy@srv-01.example.com')
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

/**
 * The window states FACTS, not JSON (nocx-n7xha).
 *
 * What a person saw: a 32-hex session id printed back inside a JSON blob,
 * above a sentence that named the tab the blob was identifying; no word
 * anywhere about which directory the call lands in; and two of five
 * paragraphs spent explaining policy.
 *
 * Three properties are asserted here and they are the whole bead:
 *
 *  - EXHAUSTIVE BY CONSTRUCTION. Every parsed argument is a named row, for
 *    every tool, including one this surface has never heard of. That is
 *    what makes dropping the blob honest — njn8s's rule survives, it is
 *    just no longer satisfied per-tool.
 *  - THE ID IS GONE. A value naming a resource the window has already named
 *    renders as the product's name for it, and the handle appears on no
 *    surface of the window.
 *  - A GUESS IS NOT A FACT. The working directory is named, and a cwd no
 *    OSC 7 report confirmed says so (AD-5). An approval window that printed
 *    a guess as fact would lie at the moment lying is most expensive.
 */
describe('AgentApprovalPrompt — the facts, not the JSON (nocx-n7xha)', () => {
  afterEach(cleanup)

  const SESSION_ASK: AgentApprovalRequested = {
    ...POLICY_ASK,
    tool: 'readScreen',
    arguments: `{"sessionId":"${SID}"}`,
    resource: { kind: 'session', id: SID },
  }

  /** Every row as `name` + `value`, in the order the window reads. The
   *  note lives inside the value cell (it qualifies that value and must not
   *  be able to drift to another row), so it is subtracted here. */
  function rows(container: HTMLElement): Array<[string, string]> {
    return Array.from(container.querySelectorAll('.ui-fact-list__row')).map((r) => {
      const value = r.querySelector('.ui-fact-list__value')?.textContent ?? ''
      const note = r.querySelector('.ui-fact-list__note')?.textContent ?? ''
      return [r.querySelector('.ui-fact-list__name')?.textContent ?? '', value.replace(note, '')]
    })
  }

  it('shows every parsed argument as a named row, including ones it has no words for', () => {
    const { container } = renderPrompt({
      ask: {
        ...SESSION_ASK,
        arguments: `{"sessionId":"${SID}","region":{"start":0,"end":24},"why":"because"}`,
      },
      sessionWhere: () => HERE,
    })
    const named = rows(container).map(([name]) => name)
    // Nothing is dropped, and the order is the model's own.
    expect(named).toEqual(['sessionId', 'region', 'why', 'working directory'])
    expect(rows(container)[1][1]).toBe('{"start":0,"end":24}')
    expect(rows(container)[2][1]).toBe('because')
  })

  it('does the same for a tool nobody has written a sentence for', () => {
    const { container } = renderPrompt({
      ask: {
        ...POLICY_ASK,
        tool: 'someone.elses.tool',
        arguments: '{"target":"prod","force":true,"retries":3}',
        resource: null,
      },
    })
    expect(rows(container)).toEqual([
      ['target', 'prod'],
      ['force', 'true'],
      ['retries', '3'],
    ])
    expect(container.textContent ?? '').toContain('someone.elses.tool')
  })

  it('keeps the verbatim blob when the arguments are not an object — that fallback stays', () => {
    const { container } = renderPrompt({
      ask: { ...SESSION_ASK, arguments: '[1,2,3]' },
      sessionWhere: () => HERE,
    })
    expect(container.querySelector('.ui-code-block')?.textContent).toBe('[1,2,3]')
    expect(container.querySelector('.ui-fact-list')).toBeNull()
    expect(container.textContent ?? '').toContain('with these arguments')
  })

  it('names the working directory the shell confirmed, and says the shell confirmed it', () => {
    const { container } = renderPrompt({ ask: SESSION_ASK, sessionWhere: () => HERE })
    const row = rows(container).find(([name]) => name === 'working directory')
    expect(row?.[1]).toContain('/home/dev')
    const note = container.querySelector('.ui-fact-list__note')?.textContent ?? ''
    expect(note).toContain('reported by the shell')
    // It is the pane's directory AS OF NOW. Binding the effect to the
    // precondition is a different bead (nocx-d6gn4.1) and this window must
    // not read as though it had already happened.
    expect(note).toContain('as of now')
  })

  it('says so when the working directory is a guess the shell never confirmed', () => {
    const { container } = renderPrompt({
      ask: SESSION_ASK,
      sessionWhere: () => ({ ...HERE, cwd: '~/Documents', cwdVerified: false }),
    })
    const row = rows(container).find(([name]) => name === 'working directory')
    expect(row?.[1]).toContain('~/Documents')
    const note = container.querySelector('.ui-fact-list__note')?.textContent ?? ''
    expect(note).toContain('has not confirmed')
    expect(note).toContain('as of now')
  })

  it('says nothing about a directory when the pane has none to report', () => {
    const { container } = renderPrompt({
      ask: SESSION_ASK,
      sessionWhere: () => ({ ...HERE, cwd: '', cwdVerified: false }),
    })
    expect(rows(container).map(([name]) => name)).toEqual(['sessionId'])
  })

  it("names run's directory too, beside the sentence rather than instead of it", () => {
    const { container } = renderPrompt({
      ask: {
        ...POLICY_ASK,
        tool: 'run',
        effect: 'mutate-destructive',
        arguments: `{"command":"rm -rf build","sessionId":"${SID}"}`,
        resource: { kind: 'session', id: SID },
      },
      sessionWhere: () => HERE,
    })
    const text = container.textContent ?? ''
    // njn8s's sentence is untouched: command in a code block, machine and
    // tab in the lead.
    expect(text).toContain('run this command')
    expect(text).toContain('this machine')
    expect(text).toContain('home/dev')
    expect(container.querySelector('.ui-code-block')?.textContent).toBe('rm -rf build')
    // And the directory is added beside it. The two arguments the sentence
    // already states are not repeated as rows — where a call lands has one
    // owner on this surface, not two.
    expect(rows(container)).toEqual([['working directory', '/home/dev']])
  })

  it('puts the decision facts before the policy prose', () => {
    const { container } = renderPrompt({ ask: SESSION_ASK, sessionWhere: () => HERE })
    const text = container.textContent ?? ''
    const facts = text.indexOf('working directory')
    const effect = text.indexOf('This call can')
    const covers = text.indexOf('Approving covers this call')
    const lasts = text.indexOf('An answer in this session lasts')
    expect(facts).toBeGreaterThan(-1)
    expect(effect).toBeGreaterThan(facts)
    expect(covers).toBeGreaterThan(effect)
    expect(lasts).toBeGreaterThan(covers)
  })
})

describe('AgentApprovalPrompt', () => {
  afterEach(cleanup)

  it('names the tool, the arguments and the reason — the question a person decides', () => {
    const { container } = renderPrompt()
    expect(container.textContent).toContain('files.read')
    // The argument, as a named row. It used to be the JSON blob
    // `{"path":"/repo/a.txt"}`; a person deciding is owed the fact, not
    // the encoding (nocx-n7xha).
    expect(container.querySelector('.ui-fact-list__name')?.textContent).toBe('path')
    expect(container.querySelector('.ui-fact-list__value')?.textContent).toBe('/repo/a.txt')
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
