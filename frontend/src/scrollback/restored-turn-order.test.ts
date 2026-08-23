// @vitest-environment jsdom
//
// Restore reproduces the live arrangement, and the comparison is against a
// LIVE turn's DOM (nocx-h1l4o, criterion 3).
//
// Not against a fixture this file wrote: a fixture is what the author of the
// restore path believed the live path draws, and the two agree exactly where
// nobody looked. So both sides are built here, through their real owners —
// BlockManager for the live flow, restoredBlock plus arrangedByCause for the
// restored one — and the assertion is that the two DOMs read the same.
//
// WHAT IS COMPARED, and it is stated because "the same" needs a definition:
// the sequence of blocks in the scrollback, and inside a turn the sequence of
// its flow elements. Not the live block's chrome — a restored block carries
// data-restored and offers nothing that needs a process (ADR-0019 §3), which
// is a difference the product REQUIRES.
//
// WHAT IS DELIBERATELY NOT REPRODUCED: the reasoning note, which ADR-0036
// does not persist at all, and the exact offset within the prose at which a
// call arrived, which is not a stored fact — the answer is one artifact, not
// a timeline. See RestoredBlockFacts.calls.

import { describe, it, expect } from 'vitest'
import { BlockManager } from './blocks'
import { restoredBlock } from './restored-block'
import { arrangedByCause, type RestorableBlock, type RestoredCause } from '../restore-client'
import { DEFAULT_SNAPSHOT } from './serializer'
import { CommandSnapshotStore } from '../command-snapshot'

const S = DEFAULT_SNAPSHOT

/** A scrollback the manager can own, attached like the real one. */
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

/** The flow inside one turn, as "kind:text" in DOM order — the same reading
 *  the live flow's own tests take, so the two sides are read identically. */
function flowOf(el: HTMLElement): string[] {
  const body = el.querySelector('[data-answer-body]')
  return Array.from(body?.children ?? []).map((c) => {
    if (c.classList.contains('ui-tool-call'))
      return `call:${c.querySelector('.ui-tool-call__tool')?.textContent ?? ''}`
    if (c.classList.contains('term-line')) return `text:${c.textContent ?? ''}`
    return c.className
  })
}

/** Every block in a container, as "kind:header" in DOM order. */
function documentOrder(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.cmd-block')).map(
    (b) =>
      `${(b as HTMLElement).dataset.blockKind ?? 'command'}:` +
      `${b.querySelector('.cmd-header-text')?.textContent ?? ''}`,
  )
}

// The turn under test, in one description both sides are built from: the
// assistant is asked something, reaches for two tools — the second of them
// `run`, which opens a real block — and then answers.
const QUESTION = 'what went wrong?'
const ANSWER = 'line 3 is wrong'
const COMMAND = 'cat -n a.txt'
const CALLS = [
  { tool: 'files.read', effect: 'observe' as const, resource: { kind: 'path', id: '/repo/a.txt' } },
  { tool: 'run', effect: 'mutate-destructive' as const },
]

describe('a restored turn reads the same as the live one it came from', () => {
  it('draws the same flow inside the turn — the calls it made, then its prose', () => {
    const { manager } = newManager()
    const live = manager.addAnswerBlock(QUESTION, '/repo')
    for (const c of CALLS) live.toolCall({ callId: c.tool, ...c })
    live.append(ANSWER)
    live.close('success')

    const restored = restoredBlock(
      {
        id: 1,
        command: QUESTION,
        cwd: '/repo',
        location: '',
        durationMs: 0,
        exitCode: null,
        status: 'success',
        body: ANSWER,
        author: 'agent',
        kind: 'ask',
        entryId: 'turn-1',
        calls: CALLS,
      },
      S,
      () => document.createElement('div'),
      () => {},
      new CommandSnapshotStore(),
    )

    expect(flowOf(restored)).toEqual(flowOf(live.el))
    // And the flow is not trivially equal by being empty on both sides.
    expect(flowOf(live.el)).toEqual(['call:files.read', 'call:run', `text:${ANSWER}`])
  })

  it('puts the command the turn ran where the live path put it: after the turn', () => {
    // LIVE. The answer block is opened when the question is asked; the run
    // tool's command opens its own block, which the scrollback appends after
    // it. The block owns the command, the line owns when — the ownership
    // submitAgentCommand states.
    const { inner, manager } = newManager()
    const live = manager.addAnswerBlock(QUESTION, '/repo')
    live.toolCall({ callId: 'c1', tool: 'run', effect: 'mutate-destructive' })
    manager.startBlock(COMMAND, '/repo', 0, 0, 'agent')
    live.append(ANSWER)
    live.close('success')
    const liveOrder = documentOrder(inner)

    // RESTORED. The page comes back in ledger order — and here the command
    // does NOT immediately follow its turn, because a person typed something
    // in this pane while the assistant was working. Ledger order alone would
    // draw the command after that; the relation puts it back.
    const page: RestorableBlock[] = [
      block('turn-1', QUESTION, 'agent'),
      block('typed-1', 'git status', 'shell'),
      block('cmd-1', COMMAND, 'agent'),
    ]
    const causes: Record<string, RestoredCause[]> = {
      'turn-1': [shellCause('cmd-1', 0)],
    }
    const arranged = arrangedByCause(page, (id) => causes[id] ?? [])
    const restoredRoot = draw(arranged, { 'turn-1': ['run'] })

    // The turn and the command it ran are adjacent, in that order, exactly
    // as they were live — and the block a person typed keeps its own place.
    expect(documentOrder(restoredRoot)).toEqual([
      `ask:${QUESTION}`,
      `command:${COMMAND}`,
      'command:git status',
    ])
    expect(documentOrder(restoredRoot).slice(0, 2)).toEqual(liveOrder)
  })

  // ── criterion 4, in the DOM: the three ways the relation is not there ───

  it('with no relation the command is an independent agent block in ledger order', () => {
    const page: RestorableBlock[] = [
      block('turn-1', QUESTION, 'agent'),
      block('typed-1', 'git status', 'shell'),
      block('cmd-1', COMMAND, 'agent'),
    ]
    const root = draw(
      arrangedByCause(page, () => []),
      {},
    )
    expect(documentOrder(root)).toEqual([
      `ask:${QUESTION}`,
      'command:git status',
      `command:${COMMAND}`,
    ])
    // It is drawn as what it is — a command the assistant ran — and it is
    // NOT attached to the turn that happens to sit above it.
    const agentBlocks = Array.from(root.querySelectorAll('[data-author="agent"]'))
    expect(agentBlocks.length).toBeGreaterThan(0)
    expect(root.querySelector('.ui-tool-call')).toBeNull()
  })

  it('an unreadable relation draws the same as none, and never guesses a parent', () => {
    // The store could not be asked, so every entry answers with no causes.
    // The command sits at its ledger position and the turn shows no calls.
    const page: RestorableBlock[] = [
      block('turn-1', QUESTION, 'agent'),
      block('cmd-1', COMMAND, 'agent'),
    ]
    const root = draw(
      arrangedByCause(page, () => []),
      {},
    )
    expect(documentOrder(root)).toEqual([`ask:${QUESTION}`, `command:${COMMAND}`])
    expect(root.querySelector('.ui-tool-call')).toBeNull()
  })

  it('a dangling cause costs the turn that fragment and nothing else', () => {
    // The command is older than the page limit, or retention took it. The
    // turn still draws the call line it made, and every block the page DOES
    // hold is still drawn.
    const page: RestorableBlock[] = [
      block('turn-1', QUESTION, 'agent'),
      block('typed-1', 'git status', 'shell'),
    ]
    const causes: Record<string, RestoredCause[]> = {
      'turn-1': [shellCause('evicted-1', 0), shellCause('cmd-gone', 1)],
    }
    const root = draw(
      arrangedByCause(page, (id) => causes[id] ?? []),
      { 'turn-1': ['run'] },
    )
    expect(documentOrder(root)).toEqual([`ask:${QUESTION}`, 'command:git status'])
    expect(root.querySelector('.ui-tool-call__tool')?.textContent).toBe('run')
  })
})

// ── the two builders both sides of the comparison share ──────────────────

function block(entryId: string, command: string, author: 'shell' | 'agent'): RestorableBlock {
  return {
    entryId,
    command,
    cwd: '/repo',
    host: '',
    status: 'success',
    durationMs: 0,
    exitCode: 0,
    author,
  }
}

function shellCause(entryId: string, position: number): RestoredCause {
  return { entryId, position, kind: 'shell', intent: 'cmd', effect: null, resource: null }
}

/** Draw a restored page the way the pane does: one block per row, with the
 *  turn's own calls placed in its flow. */
function draw(page: RestorableBlock[], calls: Record<string, string[]>): HTMLElement {
  const root = document.createElement('div')
  const store = new CommandSnapshotStore()
  for (const b of page) {
    root.appendChild(
      restoredBlock(
        {
          id: 0,
          command: b.command,
          cwd: b.cwd,
          location: b.host,
          durationMs: b.durationMs,
          exitCode: b.exitCode,
          status: b.status,
          body: b.author === 'agent' && b.entryId.startsWith('turn') ? ANSWER : 'out',
          author: b.author,
          kind: b.entryId.startsWith('turn') ? 'ask' : 'command',
          entryId: b.entryId,
          calls: (calls[b.entryId] ?? []).map((tool) => ({
            tool,
            effect: 'mutate-destructive' as const,
          })),
        },
        S,
        () => document.createElement('div'),
        () => {},
        store,
      ),
    )
  }
  return root
}
