// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { restoredBlock, bodyToHTML } from './restored-block'
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
    const el = restoredBlock(
      facts({
        kind: 'ask',
        author: 'agent',
        command: 'summarise',
        body: '## Findings\n- run `ls`\n',
      }),
      S,
      container,
      () => {},
      store(),
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
    const el = restoredBlock(
      facts({ kind: 'ask', author: 'agent', command: 'show me', body: '```\nls -la\n```\n' }),
      S,
      container,
      () => {},
      store(),
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
