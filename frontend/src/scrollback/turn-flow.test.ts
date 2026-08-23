// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  TOOL_CALL_GROUP_THRESHOLD,
  createToolCallStrip,
  turnPieces,
  type TurnCause,
} from './turn-flow'

function cause(over: Partial<TurnCause> & Pick<TurnCause, 'entryId'>): TurnCause {
  return {
    at: 0,
    kind: 'action',
    intent: 'readScreen',
    effect: 'observe',
    resource: null,
    opensBlock: false,
    ...over,
  }
}

describe('turnPieces — one causal sequence, projected as itself', () => {
  it('with no causes a turn is exactly its prose, and nothing else', () => {
    expect(turnPieces('the whole answer', [])).toEqual([{ kind: 'text', text: 'the whole answer' }])
  })

  it('cuts the prose where each cause happened', () => {
    const pieces = turnPieces('before. after.', [
      cause({
        entryId: 'cmd-1',
        kind: 'shell',
        intent: 'df -h',
        effect: null,
        at: 'before.'.length,
      }),
    ])
    expect(pieces).toEqual([
      { kind: 'text', text: 'before.' },
      { kind: 'block', entryId: 'cmd-1' },
      { kind: 'text', text: ' after.' },
    ])
  })

  it('an action that opened a block leaves NO line — the block is the account of it', () => {
    // The two rows one `run` call writes: the action entry of the call and
    // the command entry of the command it ran, at the same anchor.
    const pieces = turnPieces('answer', [
      cause({ entryId: 'act-1', intent: 'run', effect: 'mutate-destructive', opensBlock: true }),
      cause({ entryId: 'cmd-1', kind: 'shell', intent: 'df -h', effect: null }),
    ])
    expect(pieces).toEqual([
      { kind: 'block', entryId: 'cmd-1' },
      { kind: 'text', text: 'answer' },
    ])
  })

  it('an action that opened nothing keeps its line, carrying the backend facts verbatim', () => {
    const pieces = turnPieces('answer', [
      cause({
        entryId: 'act-1',
        intent: 'readScreen',
        effect: 'observe',
        resource: { kind: 'session', id: 'sess-1' },
      }),
    ])
    expect(pieces).toEqual([
      {
        kind: 'call',
        call: {
          tool: 'readScreen',
          effect: 'observe',
          resource: { kind: 'session', id: 'sess-1' },
        },
      },
      { kind: 'text', text: 'answer' },
    ])
  })

  it('a call whose row carries no effect is drawn as an observation, never dropped', () => {
    const pieces = turnPieces('', [cause({ entryId: 'act-1', effect: null })])
    expect(pieces).toEqual([
      { kind: 'call', call: { tool: 'readScreen', effect: 'observe', resource: undefined } },
    ])
  })

  it('never cuts backwards: an anchor behind the one before it stays where the prose is', () => {
    const pieces = turnPieces('abcdef', [
      cause({ entryId: 'a', at: 4 }),
      cause({ entryId: 'b', at: 1 }),
    ])
    expect(pieces).toEqual([
      { kind: 'text', text: 'abcd' },
      { kind: 'call', call: { tool: 'readScreen', effect: 'observe', resource: undefined } },
      { kind: 'call', call: { tool: 'readScreen', effect: 'observe', resource: undefined } },
      { kind: 'text', text: 'ef' },
    ])
  })

  it('an anchor past the end of the prose lands at the end, not out of it', () => {
    const pieces = turnPieces('abc', [cause({ entryId: 'a', at: 99 })])
    expect(pieces).toEqual([
      { kind: 'text', text: 'abc' },
      { kind: 'call', call: { tool: 'readScreen', effect: 'observe', resource: undefined } },
    ])
  })

  it('cuts by UTF-16 code units, so a Cyrillic answer is never split mid-word', () => {
    // The owner's own question was Russian; a byte offset would land inside
    // a character here and the two halves would be mojibake.
    const answer = 'занято 79%'
    const pieces = turnPieces(answer, [cause({ entryId: 'a', at: 'занято'.length })])
    expect(pieces).toEqual([
      { kind: 'text', text: 'занято' },
      { kind: 'call', call: { tool: 'readScreen', effect: 'observe', resource: undefined } },
      { kind: 'text', text: ' 79%' },
    ])
  })

  it('a turn whose prose is gone still draws what it did — the calls survive the loss', () => {
    const pieces = turnPieces(null, [
      cause({ entryId: 'act-1' }),
      cause({ entryId: 'cmd-1', kind: 'shell', intent: 'ls', effect: null }),
    ])
    expect(pieces).toEqual([
      { kind: 'call', call: { tool: 'readScreen', effect: 'observe', resource: undefined } },
      { kind: 'block', entryId: 'cmd-1' },
    ])
  })
})

describe('the tool-call strip — five calls stay readable', () => {
  /** A body that records what was placed in it, the way an answer body does. */
  function newBody() {
    const el = document.createElement('div')
    return {
      el,
      insert(node: HTMLElement) {
        el.appendChild(node)
      },
    }
  }

  it('draws a short run as its own lines — one call is a sentence, not a log', () => {
    const body = newBody()
    const strip = createToolCallStrip(body)
    for (let i = 0; i < TOOL_CALL_GROUP_THRESHOLD - 1; i++) {
      strip.add({ tool: `t${i}`, effect: 'observe' })
    }
    expect(body.el.querySelectorAll(':scope > .ui-tool-call')).toHaveLength(
      TOOL_CALL_GROUP_THRESHOLD - 1,
    )
    expect(body.el.querySelector('.ui-tool-calls')).toBeNull()
  })

  it('compacts five calls into ONE expandable line holding all five', () => {
    const body = newBody()
    const strip = createToolCallStrip(body)
    for (const tool of ['readScreen', 'blocks.list', 'blocks.read', 'files.read', 'git.status']) {
      strip.add({ tool, effect: 'observe' })
    }
    // One thing in the flow, not five.
    expect(body.el.children).toHaveLength(1)
    const group = body.el.querySelector('.ui-tool-calls')
    expect(group).not.toBeNull()
    expect(group!.querySelectorAll('.ui-tool-call')).toHaveLength(5)
    // And it says how many, so the compaction hides nothing.
    expect(group!.querySelector('.ui-tool-calls__summary')?.textContent).toContain('5')
  })

  it('the compacted group sits where the run began, not at the end of the flow', () => {
    const body = newBody()
    const strip = createToolCallStrip(body)
    strip.add({ tool: 'a', effect: 'observe' })
    strip.add({ tool: 'b', effect: 'observe' })
    strip.add({ tool: 'c', effect: 'observe' })
    strip.add({ tool: 'd', effect: 'observe' })
    expect(body.el.firstElementChild?.className).toBe('ui-tool-calls')
  })

  it('prose between two runs ends the first one — a run is consecutive, or it is two', () => {
    const body = newBody()
    const strip = createToolCallStrip(body)
    for (let i = 0; i < TOOL_CALL_GROUP_THRESHOLD; i++)
      strip.add({ tool: `a${i}`, effect: 'observe' })
    strip.end()
    strip.add({ tool: 'after', effect: 'observe' })
    expect(body.el.querySelectorAll(':scope > .ui-tool-calls')).toHaveLength(1)
    expect(body.el.querySelectorAll(':scope > .ui-tool-call')).toHaveLength(1)
  })
})
