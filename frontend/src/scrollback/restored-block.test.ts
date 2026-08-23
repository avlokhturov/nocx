// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { restoredBlock, restoredTurn, bodyToHTML, type RestoredTurnFacts } from './restored-block'
import type { TurnCause } from './turn-flow'
import { DEFAULT_SNAPSHOT, serializeRange, serializeRangeSGR } from './serializer'
import { BufferLine, lineWith, XTERM_CM_P16 } from './test-helpers'
import { CommandSnapshotStore } from '../command-snapshot'

const S = DEFAULT_SNAPSHOT
const store = () => new CommandSnapshotStore()
const container = () => document.createElement('div')

const facts = (over: Partial<Parameters<typeof restoredBlock>[0]> = {}) => ({
  id: 1,
  command: 'make test',
  cwd: '/repo',
  location: '',
  durationMs: 1200,
  exitCode: 0,
  status: 'success' as const,
  body: 'all good',
  author: 'shell' as const,
  kind: 'command' as const,
  ...over,
})

describe('a block built from the store', () => {
  it('renders the stored rows exactly as the live path rendered them', () => {
    const lines = [
      lineWith(
        { chars: 'o', fg: 2, fgMode: XTERM_CM_P16, bgMode: 0 },
        { chars: 'k', fg: 2, fgMode: XTERM_CM_P16, bgMode: 0 },
      ),
      new BufferLine('second', false),
    ]
    const getLine = (y: number) => lines[y]
    expect(bodyToHTML(S, serializeRangeSGR(getLine, 0, 1))).toBe(serializeRange(S, getLine, 0, 1))
  })

  it('says it is restored, in the DOM a gate can read', () => {
    const el = restoredBlock(facts(), S, container, () => {}, store())
    expect(el.dataset.restored).toBe('true')
    expect(el.classList.contains('cmd-block')).toBe(true)
  })

  it('carries the command, the directory and the outcome', () => {
    const el = restoredBlock(
      facts({ exitCode: 2, status: 'failure' }),
      S,
      container,
      () => {},
      store(),
    )
    expect(el.textContent).toContain('make test')
    expect(
      el.querySelector('.cmd-block-failure, [data-status="failure"]') ?? el.outerHTML,
    ).toBeTruthy()
    expect(el.outerHTML).toContain('repo')
  })

  it('says the output is GONE when it is gone, and says nothing when there was none', () => {
    // The two states a restored block must not confuse. Retention evicts
    // bodies while their entries stay (ADR-0019 §7), so "no artifact" is a
    // hole to name; a command that printed nothing is not.
    const evicted = restoredBlock(facts({ body: null }), S, container, () => {}, store())
    expect(evicted.dataset.outputEvicted).toBe('true')
    expect(evicted.textContent).toContain('Output is no longer kept')

    const silent = restoredBlock(facts({ body: '' }), S, container, () => {}, store())
    expect(silent.dataset.outputEvicted).toBeUndefined()
    expect(silent.textContent).not.toContain('Output is no longer kept')
  })

  it('paints with the CURRENT theme, which is why the body keeps SGR', () => {
    const red = restoredBlock(facts({ body: '\u001b[31mred' }), S, container, () => {}, store())
    expect(red.outerHTML).toContain(String(S.palette[1]))
  })

  // The badge half of nocx-4em1z, asserted through the seam a person reaches
  // it by: the entry says the assistant submitted the command, so the
  // restored block says so too. Before this, restoredBlock omitted the
  // argument entirely and the parameter defaulted to 'shell' — the block
  // came back looking like something the person had typed.
  it('paints the agent badge on a command the assistant ran', () => {
    const el = restoredBlock(facts({ author: 'agent' }), S, container, () => {}, store())
    const badge = el.querySelector('.ui-badge')
    expect(badge?.textContent).toBe('agent')
  })

  it("a person's own command carries no author mark at all", () => {
    const el = restoredBlock(facts(), S, container, () => {}, store())
    expect(el.querySelector('.ui-badge')).toBeNull()
  })

  // ── a restored assistant turn (nocx-4em1z) ──────────────────────────────
  //
  // The owner's report was that every dialogue vanished from a restored tab.
  // A turn is one entry — the question is its header, the answer is its body
  // — so it comes back as the block it was, in the ask grammar, drawn by the
  // SAME renderer that draws a live answer.
  it('comes back as an ask block with the question in its header', () => {
    const el = restoredBlock(
      facts({
        kind: 'ask',
        author: 'agent',
        command: 'what does this do?',
        body: 'It lists files.',
      }),
      S,
      container,
      () => {},
      store(),
    )
    expect(el.dataset.blockKind).toBe('ask')
    expect(el.querySelector('.cmd-header-text')?.textContent).toBe('what does this do?')
    expect(el.dataset.restored).toBe('true')
  })

  it("draws the answer as prose, through the answer body's own renderer", () => {
    // Through restoredTurn, which is the ONE builder of a turn's prose: the
    // block builder draws the pieces it is handed, and the projection that
    // produces them is the turn's (nocx-9sqii).
    const [el] = restoredTurn(
      facts({
        kind: 'ask',
        author: 'agent',
        command: 'summarise',
        body: '## Findings\n- run `ls`\n',
        id: undefined,
      }),
      S,
      () => 1,
      container,
      () => {},
      store(),
      () => null,
    )
    // The ask kind's body class — the wrap policy lives there, and a restored
    // answer must wrap exactly as a live one does.
    const body = el.querySelector('.cmd-output-ask')
    expect(body).not.toBeNull()
    // And the markdown is painted, not printed: the heading is a heading and
    // the inline code is code (ui/answer-markdown.ts owns the grammar).
    expect(body?.querySelector('[data-md="h2"]')).not.toBeNull()
    expect(body?.querySelector('.ui-md-code')?.textContent).toBe('ls')
  })

  it('keeps a fenced block in the command grammar, as the live answer does', () => {
    const [el] = restoredTurn(
      facts({
        kind: 'ask',
        author: 'agent',
        command: 'show me',
        body: '```\nls -la\n```\n',
        id: undefined,
      }),
      S,
      () => 1,
      container,
      () => {},
      store(),
      () => null,
    )
    expect(el.querySelector('.cmd-output-code')).not.toBeNull()
  })

  it('carries its entry id, so Copy output reads the stored answer', () => {
    const el = restoredBlock(
      facts({ kind: 'ask', author: 'agent', entryId: 'entry-9', body: 'hi' }),
      S,
      container,
      () => {},
      store(),
    )
    expect(el.dataset.entryId).toBe('entry-9')
  })

  it('says the answer is gone rather than pretending the model said nothing', () => {
    const el = restoredBlock(
      facts({ kind: 'ask', author: 'agent', body: null }),
      S,
      container,
      () => {},
      store(),
    )
    expect(el.textContent).toContain('Output is no longer kept')
    expect(el.dataset.outputEvicted).toBe('true')
  })
})

// ── a restored turn comes back as the turn it was (nocx-h1l4o, nocx-9sqii) ──
//
// ADR-0036's last sentence: an action was anchored to nothing at all, so a
// restored turn came back without the calls it made. The `caused-by` relation
// joins them, and this is the drawing half — the lines are built by the SAME
// kit component the live flow places, from the facts the ledger stored, and
// the turn is drawn as the same fragments the live path drew.
describe('a restored turn and what it caused', () => {
  const turn = (causes: TurnCause[], over: Partial<RestoredTurnFacts> = {}) => {
    let n = 100
    return restoredTurn(
      {
        command: 'what went wrong?',
        cwd: '/repo',
        location: '',
        durationMs: 1200,
        exitCode: null,
        status: 'success',
        body: 'line 3 is wrong',
        author: 'agent',
        kind: 'ask',
        entryId: 'turn-1',
        causes,
        ...over,
      },
      S,
      () => n++,
      container,
      () => {},
      store(),
      (entryId) =>
        entryId === 'gone'
          ? null
          : restoredBlock(
              facts({ id: n++, command: `cmd ${entryId}`, author: 'agent', entryId }),
              S,
              container,
              () => {},
              store(),
            ),
    )
  }

  const call = (over: Partial<TurnCause> = {}): TurnCause => ({
    entryId: 'act-1',
    at: 0,
    kind: 'action',
    intent: 'files.read',
    effect: 'observe',
    resource: null,
    opensBlock: false,
    ...over,
  })

  it('draws one tool-call line per call, in the causal order the ledger gave', () => {
    const [el] = turn([
      call({ resource: { kind: 'path', id: '/repo/a.txt' } }),
      call({ entryId: 'act-2', intent: 'git.status' }),
    ])
    const lines = Array.from(el.querySelectorAll('.ui-tool-call__tool')).map((n) => n.textContent)
    expect(lines).toEqual(['files.read', 'git.status'])
  })

  it('paints the effect the backend decided, never one derived from the name', () => {
    const [el] = turn([call({ intent: 'rm', effect: 'mutate-destructive' })])
    expect(el.querySelector<HTMLElement>('.ui-tool-call')?.dataset.effect).toBe(
      'mutate-destructive',
    )
  })

  it('shows the resource the backend derived, and nothing when it derived none', () => {
    const [named] = turn([call({ resource: { kind: 'path', id: '/repo/a.txt' } })])
    expect(named.querySelector('.ui-tool-call__resource')?.textContent).toBe('/repo/a.txt')
    const [bare] = turn([call({ intent: 'git.status' })])
    expect(bare.querySelector('.ui-tool-call__resource')).toBeNull()
  })

  it('places the calls inside the turn’s own body, above the prose it preceded', () => {
    const [el] = turn([call()])
    const body = el.querySelector('[data-answer-body]')
    const kinds = Array.from(body?.children ?? []).map((c) =>
      c.classList.contains('ui-tool-call') ? 'call' : 'text',
    )
    expect(kinds).toEqual(['call', 'text'])
  })

  it('cuts the prose where the call happened, so a call mid-answer stays mid-answer', () => {
    const [el] = turn([call({ at: 'line 3'.length })])
    const body = el.querySelector('[data-answer-body]')
    const flow = Array.from(body?.children ?? []).map((c) =>
      c.classList.contains('ui-tool-call') ? 'call' : `text:${c.textContent ?? ''}`,
    )
    expect(flow).toEqual(['text:line 3', 'call', 'text: is wrong'])
  })

  it('a turn with no causes is ONE block, exactly what it drew before the relation existed', () => {
    const els = turn([])
    expect(els).toHaveLength(1)
    expect(els[0].querySelector('.ui-tool-call')).toBeNull()
    expect(els[0].querySelector('[data-answer-body]')?.textContent).toContain('line 3 is wrong')
    expect(els[0].querySelector('[data-turn-continuation]')).toBeNull()
  })

  it('a turn whose answer is gone still says the calls it made happened', () => {
    // Retention takes bodies and leaves entries (ADR-0019 §7). The calls are
    // entries of their own, so they survive the loss of the prose — and the
    // block must not go silent about work that really happened.
    const [el] = turn([call()], { body: null })
    expect(el.textContent).toContain('Output is no longer kept')
    expect(el.querySelector('.ui-tool-call__tool')?.textContent).toBe('files.read')
  })

  it('a COMMAND block never grows a call line, whatever it is handed', () => {
    // An action has no block and no command line; a call belongs to the turn
    // that made it, and a second owner of that fact is the defect.
    const el = restoredBlock(
      facts({ pieces: [{ kind: 'call', call: { tool: 'files.read', effect: 'observe' } }] }),
      S,
      container,
      () => {},
      store(),
    )
    expect(el.querySelector('.ui-tool-call')).toBeNull()
  })

  // ── the fragments (nocx-9sqii) ───────────────────────────────────────────

  it('puts the command the turn ran BETWEEN the prose before it and the prose from it', () => {
    const els = turn([
      call({ intent: 'run', effect: 'mutate-destructive', opensBlock: true, at: 'line 3'.length }),
      call({
        entryId: 'cmd-1',
        kind: 'shell',
        intent: 'cat -n a.txt',
        effect: null,
        at: 'line 3'.length,
      }),
    ])
    expect(els).toHaveLength(3)
    expect(els[0].querySelector('[data-answer-body]')?.textContent).toBe('line 3')
    expect(els[1].querySelector('.cmd-header-text')?.textContent).toBe('cmd cmd-1')
    expect(els[2].querySelector('[data-answer-body]')?.textContent).toBe(' is wrong')
    // The run call left NO line: the block is the account of it.
    expect(els[0].querySelector('.ui-tool-call')).toBeNull()
    expect(els[2].querySelector('.ui-tool-call')).toBeNull()
  })

  it('every fragment carries the turn’s stored identity, and a continuation says so', () => {
    const els = turn([call({ entryId: 'cmd-1', kind: 'shell', intent: 'ls', effect: null, at: 4 })])
    const fragments = els.filter((e) => e.dataset.turnFragment !== undefined)
    expect(fragments.map((f) => f.dataset.entryId)).toEqual(['turn-1', 'turn-1'])
    expect(fragments.map((f) => f.dataset.turnFragment)).toEqual(['0', '1'])
    expect(fragments[0].querySelector('[data-turn-continuation]')).toBeNull()
    expect(fragments[1].querySelector('[data-turn-continuation]')?.textContent).toBe('continued')
  })

  it('the turn’s outcome is on the fragment where the turn ENDED, not halfway down it', () => {
    const els = turn([call({ entryId: 'cmd-1', kind: 'shell', intent: 'ls', effect: null, at: 4 })])
    const fragments = els.filter((e) => e.dataset.turnFragment !== undefined)
    expect(fragments[0].querySelector('.cmd-header-duration')).toBeNull()
    expect(fragments[1].querySelector('.cmd-header-duration')?.textContent).toBe('1.2s')
  })

  it('a turn whose last act was a command opens no empty fragment under it', () => {
    const els = turn([
      call({ entryId: 'cmd-1', kind: 'shell', intent: 'ls', effect: null, at: 99 }),
    ])
    expect(els).toHaveLength(2)
    expect(els[1].dataset.turnFragment).toBeUndefined()
  })

  it('a DANGLING cause costs the turn that block and nothing else', () => {
    // The command is older than the page limit, or retention took it. Every
    // fragment the turn does have is still drawn, in order.
    const els = turn([call({ entryId: 'gone', kind: 'shell', intent: 'ls', effect: null, at: 4 })])
    expect(els.map((e) => e.dataset.turnFragment)).toEqual(['0', '1'])
    expect(els[0].querySelector('[data-answer-body]')?.textContent).toBe('line')
    expect(els[1].querySelector('[data-answer-body]')?.textContent).toBe(' 3 is wrong')
  })

  it('five calls compact into one expandable line here too, as they do live', () => {
    const [el] = turn(
      ['readScreen', 'blocks.list', 'blocks.read', 'files.read', 'git.status'].map((intent, i) =>
        call({ entryId: `act-${i}`, intent }),
      ),
    )
    expect(el.querySelectorAll('[data-answer-body] > .ui-tool-call')).toHaveLength(0)
    const group = el.querySelector('.ui-tool-calls')
    expect(group?.querySelectorAll('.ui-tool-call')).toHaveLength(5)
  })
})
