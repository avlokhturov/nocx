// @vitest-environment jsdom
//
// A turn reads in the order it happened (nocx-9sqii), asserted on the LIVE
// path — the scrollback the ask surface actually drives.
//
// The owner's report: he asked how much disk was free and got, in this
// order, the question, a bare `▸ run` line carrying neither arguments nor
// result, the finished answer, and THEN — below the whole turn — the `df -h`
// block with the twelve lines the answer was distilled from. One causal
// sequence drawn as a different one. Every assertion here reads DOM order,
// because document order is the claim the product is making.

import { describe, it, expect } from 'vitest'
import { BlockManager } from './blocks'
import { CommandSnapshotStore } from '../command-snapshot'

function newManager() {
  const inner = document.createElement('div')
  document.body.appendChild(inner)
  const xtermContainer = document.createElement('div')
  inner.appendChild(xtermContainer)
  const manager = new BlockManager(inner, xtermContainer, {
    snapshotStore: new CommandSnapshotStore(),
  })
  return { inner, manager }
}

/** Every block in the scrollback, as "kind:header" in DOM order. */
function documentOrder(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.cmd-block')).map(
    (b) =>
      `${(b as HTMLElement).dataset.blockKind ?? 'command'}:` +
      `${b.querySelector('.cmd-header-text')?.textContent ?? ''}`,
  )
}

/** The flow inside one block's answer body, as "kind:text" in DOM order. */
function flowOf(el: HTMLElement): string[] {
  const body = el.querySelector('[data-answer-body]')
  return Array.from(body?.children ?? []).map((c) => {
    if (c.classList.contains('ui-tool-call'))
      return `call:${c.querySelector('.ui-tool-call__tool')?.textContent ?? ''}`
    if (c.classList.contains('ui-tool-calls'))
      return `calls:${c.querySelectorAll('.ui-tool-call').length}`
    if (c.classList.contains('term-line')) return `text:${c.textContent ?? ''}`
    return c.className
  })
}

/** The turn's fragments, in DOM order. */
function fragmentsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll('[data-turn-fragment]'))
}

const QUESTION = 'Как мне проверить сколько места на диске?'
const COMMAND = 'df -h'

describe('a turn that ran a command reads in the order it happened', () => {
  it('draws question, tool activity, the command block, then the answer written from it', () => {
    const { inner, manager } = newManager()
    const turn = manager.addAnswerBlock(QUESTION, '/repo')
    turn.el.dataset.entryId = 'turn-1'
    // What the model did before it reached for the shell.
    turn.toolCall({ callId: 'c0', tool: 'readScreen', effect: 'observe', opensBlock: false })
    turn.append('Сейчас посмотрю.')
    // The `run` call: no line of its own — the block is the account of it.
    turn.toolCall({ callId: 'c1', tool: 'run', effect: 'mutate-destructive', opensBlock: true })
    // The command really runs, through the ordinary path, at the tail.
    manager.startBlock(COMMAND, '/repo', 0, 0, 'agent')
    // …and the answer written FROM its output lands below it.
    turn.append('41G свободно, занято 79%')
    turn.close('success')

    expect(documentOrder(inner)).toEqual([
      `ask:${QUESTION}`,
      `command:${COMMAND}`,
      `ask:${QUESTION}`,
    ])
    const [head, , tail] = Array.from(inner.querySelectorAll<HTMLElement>('.cmd-block'))
    expect(flowOf(head)).toEqual(['call:readScreen', 'text:Сейчас посмотрю.'])
    expect(flowOf(tail)).toEqual(['text:41G свободно, занято 79%'])
  })

  it("the run tool's line is gone: no surface restates the command, its output or its status", () => {
    const { inner, manager } = newManager()
    const turn = manager.addAnswerBlock(QUESTION, '/repo')
    turn.toolCall({ callId: 'c1', tool: 'run', effect: 'mutate-destructive', opensBlock: true })
    manager.startBlock(COMMAND, '/repo', 0, 0, 'agent')
    turn.append('41G free')
    turn.close('success')

    // Not one tool-call line anywhere in the turn, and none inside a group
    // either — the compaction must not be a place a run line hides.
    expect(inner.querySelectorAll('.ui-tool-call')).toHaveLength(0)
    // And the command text appears exactly once in the whole scrollback:
    // in the header of the block that ran it.
    const headers = documentOrder(inner).filter((h) => h.includes(COMMAND))
    expect(headers).toEqual([`command:${COMMAND}`])
  })

  it('a tool that opens no block keeps its line — nothing else owns its occurrence', () => {
    const { inner, manager } = newManager()
    const turn = manager.addAnswerBlock('what is on screen?', '/repo')
    turn.toolCall({
      callId: 'c1',
      tool: 'readScreen',
      effect: 'observe',
      opensBlock: false,
      resource: { kind: 'path', id: '/repo/a.txt' },
    })
    turn.append('a prompt')
    turn.close('success')

    expect(inner.querySelectorAll('.cmd-block')).toHaveLength(1)
    expect(flowOf(turn.el)).toEqual(['call:readScreen', 'text:a prompt'])
  })

  it('a turn drawn in fragments is ONE turn, by a stored identity and not by a colour', () => {
    const { inner, manager } = newManager()
    const turn = manager.addAnswerBlock(QUESTION, '/repo')
    turn.el.dataset.entryId = 'turn-1'
    turn.append('first')
    turn.toolCall({ callId: 'c1', tool: 'run', effect: 'mutate-destructive', opensBlock: true })
    manager.startBlock(COMMAND, '/repo', 0, 0, 'agent')
    turn.append('second')
    turn.close('success')

    const frags = fragmentsOf(inner)
    expect(frags).toHaveLength(2)
    // The identity is the turn's ledger entry, carried by every fragment.
    expect(frags.map((f) => f.dataset.entryId)).toEqual(['turn-1', 'turn-1'])
    // And a continuation says so, in its position and in words a person
    // reads — so a fragment is never mistaken for a second answer.
    expect(frags.map((f) => f.dataset.turnFragment)).toEqual(['0', '1'])
    expect(frags[0].querySelector('[data-turn-continuation]')).toBeNull()
    expect(frags[1].querySelector('[data-turn-continuation]')?.textContent).toBe('continued')
  })

  it('text written before the call stays above the block; text written after lands below it', () => {
    const { inner, manager } = newManager()
    const turn = manager.addAnswerBlock(QUESTION, '/repo')
    turn.append('before the call')
    turn.toolCall({ callId: 'c1', tool: 'run', effect: 'mutate-destructive', opensBlock: true })
    manager.startBlock(COMMAND, '/repo', 0, 0, 'agent')
    turn.append('while it was still running')
    turn.append(' and after')
    turn.close('success')

    const blocks = Array.from(inner.querySelectorAll<HTMLElement>('.cmd-block'))
    expect(flowOf(blocks[0])).toEqual(['text:before the call'])
    expect(blocks[1].dataset.blockKind ?? 'command').toBe('command')
    expect(flowOf(blocks[2])).toEqual(['text:while it was still running and after'])
    // Nothing was repainted into a position it had already left: the first
    // fragment never grew after the block was opened.
    expect(flowOf(blocks[0])).not.toContain('text:while it was still running and after')
  })

  it('five tool calls compact into one expandable line rather than five', () => {
    const { manager } = newManager()
    const turn = manager.addAnswerBlock('what have I been doing?', '/repo')
    for (const tool of ['readScreen', 'blocks.list', 'blocks.read', 'files.read', 'git.status']) {
      turn.toolCall({ callId: tool, tool, effect: 'observe', opensBlock: false })
    }
    turn.append('you have been reading logs')
    turn.close('success')

    expect(flowOf(turn.el)).toEqual(['calls:5', 'text:you have been reading logs'])
    // Compacted, never hidden: the count is on the summary and every line
    // is inside.
    const group = turn.el.querySelector('.ui-tool-calls')
    expect(group?.querySelectorAll('.ui-tool-call')).toHaveLength(5)
    expect(group?.querySelector('.ui-tool-calls__summary')?.textContent).toContain('5')
  })

  it('a turn with no tool calls is one block with its prose, exactly as before', () => {
    const { inner, manager } = newManager()
    const turn = manager.addAnswerBlock('who are you?', '/repo')
    turn.append('an assistant')
    turn.close('success', undefined, 'a-model')

    expect(inner.querySelectorAll('.cmd-block')).toHaveLength(1)
    expect(fragmentsOf(inner)).toHaveLength(1)
    expect(inner.querySelector('[data-turn-continuation]')).toBeNull()
    expect(flowOf(turn.el)).toEqual(['text:an assistant', 'cmd-answer-provenance'])
    expect(turn.el.querySelector('.cmd-header-exit')?.textContent).toBe('completed')
  })

  it('the typing dots do not outlive the turn when the answer landed in a later fragment', () => {
    const { inner, manager } = newManager()
    const turn = manager.addAnswerBlock(QUESTION, '/repo')
    turn.toolCall({ callId: 'c1', tool: 'run', effect: 'mutate-destructive', opensBlock: true })
    manager.startBlock(COMMAND, '/repo', 0, 0, 'agent')
    turn.append('41G free')
    turn.close('success')
    expect(inner.querySelector('.cmd-answer-typing')).toBeNull()
    expect(inner.querySelector('.cmd-answer-waiting')).toBeNull()
  })
})
