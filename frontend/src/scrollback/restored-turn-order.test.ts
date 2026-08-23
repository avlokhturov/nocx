// @vitest-environment jsdom
//
// Restore reproduces the live arrangement, and the comparison is against a
// LIVE turn's DOM (nocx-h1l4o criterion 3, nocx-9sqii criterion 9).
//
// Not against a fixture this file wrote: a fixture is what the author of the
// restore path believed the live path draws, and the two agree exactly where
// nobody looked. So both sides are built here, through their real owners —
// BlockManager for the live flow, restoredTurn plus arrangedByCause for the
// restored one — and the assertion is that the two DOMs read the same.
//
// WHAT IS COMPARED, and it is stated because "the same" needs a definition:
// the sequence of blocks in the scrollback, and inside each fragment of the
// turn the sequence of its flow elements. Not the live block's chrome — a
// restored block carries data-restored and offers nothing that needs a
// process (ADR-0019 §3), which is a difference the product REQUIRES.
//
// WHAT WAS DELIBERATELY NOT REPRODUCED AND NOW IS. nocx-h1l4o put a restored
// turn's calls at the HEAD of its flow, because the offset a call arrived at
// was not a stored fact — the answer was one artifact and not a timeline.
// nocx-9sqii made the turn a timeline and the offset a stored fact
// (`caused.at`), so a restored call now sits where the live one sat and this
// file asserts it. The reasoning note is still not reproduced: ADR-0036 does
// not persist it at all.

import { describe, it, expect } from 'vitest'
import { BlockManager } from './blocks'
import { restoredBlock, restoredTurn } from './restored-block'
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

/** The flow inside one turn fragment, as "kind:text" in DOM order — the same
 *  reading the live flow's own tests take, so the two sides are read
 *  identically. */
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

/** Every block in a container, as "kind:header" in DOM order. */
function documentOrder(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.cmd-block')).map(
    (b) =>
      `${(b as HTMLElement).dataset.blockKind ?? 'command'}:` +
      `${b.querySelector('.cmd-header-text')?.textContent ?? ''}`,
  )
}

/** Every fragment of a turn, in DOM order, as its index and its flow. */
function fragmentFlows(root: HTMLElement): string[][] {
  return Array.from(root.querySelectorAll('[data-turn-fragment]')).map((f) =>
    flowOf(f as HTMLElement),
  )
}

// The turn under test, in one description both sides are built from: the
// assistant is asked something, reads a file, says what it is about to do,
// runs a command — which opens a real block — and answers from its output.
const QUESTION = 'what went wrong?'
const BEFORE = 'let me look at the file. '
const AFTER = 'line 3 is wrong'
const ANSWER = BEFORE + AFTER
const COMMAND = 'cat -n a.txt'

describe('a restored turn reads the same as the live one it came from', () => {
  /** The live turn, driven through the manager exactly as the ask surface
   *  drives it: the calls arrive over the wire, the command is submitted
   *  through the ordinary path, and the answer streams around both. */
  function liveTurn() {
    const { inner, manager } = newManager()
    const live = manager.addAnswerBlock(QUESTION, '/repo')
    live.el.dataset.entryId = 'turn-1'
    live.toolCall({
      callId: 'c0',
      tool: 'files.read',
      effect: 'observe',
      resource: { kind: 'path', id: '/repo/a.txt' },
      opensBlock: false,
    })
    live.append(BEFORE)
    live.toolCall({ callId: 'c1', tool: 'run', effect: 'mutate-destructive', opensBlock: true })
    manager.startBlock(COMMAND, '/repo', 0, 0, 'agent')
    live.append(AFTER)
    live.close('success')
    return inner
  }

  it('draws the same blocks in the same order, and the same flow inside each fragment', () => {
    const live = liveTurn()

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
      'turn-1': [
        actionCause('act-0', 0, 'files.read', 0, { kind: 'path', id: '/repo/a.txt' }),
        // The `run` call and the command it opened, at the same anchor: the
        // point in the prose where the assistant reached for the shell.
        actionCause('act-1', 1, 'run', BEFORE.length, null, true),
        shellCause('cmd-1', 2, BEFORE.length),
      ],
    }
    const restored = draw(page, (id) => causes[id] ?? [], ANSWER)

    expect(documentOrder(restored)).toEqual(documentOrder(live).concat('command:git status'))
    expect(fragmentFlows(restored)).toEqual(fragmentFlows(live))
    // …and neither side is trivially equal by being empty.
    expect(fragmentFlows(live)).toEqual([['call:files.read', `text:${BEFORE}`], [`text:${AFTER}`]])
  })

  it('the fragments of one turn carry one identity on both sides', () => {
    const live = liveTurn()
    const page: RestorableBlock[] = [
      block('turn-1', QUESTION, 'agent'),
      block('cmd-1', COMMAND, 'agent'),
    ]
    const restored = draw(
      page,
      (id) =>
        id === 'turn-1'
          ? [
              actionCause('act-1', 0, 'run', BEFORE.length, null, true),
              shellCause('cmd-1', 1, BEFORE.length),
            ]
          : [],
      ANSWER,
    )
    const identity = (root: HTMLElement) =>
      Array.from(root.querySelectorAll('[data-turn-fragment]')).map(
        (f) => `${(f as HTMLElement).dataset.entryId}#${(f as HTMLElement).dataset.turnFragment}`,
      )
    expect(identity(restored)).toEqual(['turn-1#0', 'turn-1#1'])
    expect(identity(restored)).toEqual(identity(live))
  })

  it('two commands in a row leave no empty fragment between them, on either side', () => {
    // Nothing was written between the two calls, so live there is no
    // continuation there — a fragment is opened by CONTENT. The restored
    // side must not invent one.
    const { inner, manager } = newManager()
    const live = manager.addAnswerBlock(QUESTION, '/repo')
    live.el.dataset.entryId = 'turn-1'
    live.toolCall({ callId: 'c1', tool: 'run', effect: 'mutate-destructive', opensBlock: true })
    manager.startBlock('ls', '/repo', 0, 0, 'agent')
    live.toolCall({ callId: 'c2', tool: 'run', effect: 'mutate-destructive', opensBlock: true })
    manager.startBlock('pwd', '/repo', 0, 0, 'agent')
    live.append(AFTER)
    live.close('success')

    const page: RestorableBlock[] = [
      block('turn-1', QUESTION, 'agent'),
      block('cmd-1', 'ls', 'agent'),
      block('cmd-2', 'pwd', 'agent'),
    ]
    const restored = draw(
      page,
      (id) =>
        id === 'turn-1'
          ? [
              actionCause('act-1', 0, 'run', 0, null, true),
              shellCause('cmd-1', 1, 0),
              actionCause('act-2', 2, 'run', 0, null, true),
              shellCause('cmd-2', 3, 0),
            ]
          : [],
      AFTER,
    )
    expect(documentOrder(restored)).toEqual(documentOrder(inner))
    expect(documentOrder(inner)).toEqual([
      `ask:${QUESTION}`,
      'command:ls',
      'command:pwd',
      `ask:${QUESTION}`,
    ])
    expect(fragmentFlows(restored)).toEqual(fragmentFlows(inner))
  })

  // ── the three ways the relation is not there, in the DOM ────────────────

  it('with no relation the command is an independent agent block in ledger order', () => {
    const page: RestorableBlock[] = [
      block('turn-1', QUESTION, 'agent'),
      block('typed-1', 'git status', 'shell'),
      block('cmd-1', COMMAND, 'agent'),
    ]
    const root = draw(page, () => [], ANSWER)
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
    // One turn, one fragment: nothing split it, because nothing caused it to.
    expect(root.querySelectorAll('[data-turn-fragment]')).toHaveLength(1)
  })

  it('an unreadable relation draws the same as none, and never guesses a parent', () => {
    // The store could not be asked, so every entry answers with no causes.
    // The command sits at its ledger position and the turn shows no calls.
    const page: RestorableBlock[] = [
      block('turn-1', QUESTION, 'agent'),
      block('cmd-1', COMMAND, 'agent'),
    ]
    const root = draw(page, () => [], ANSWER)
    expect(documentOrder(root)).toEqual([`ask:${QUESTION}`, `command:${COMMAND}`])
    expect(root.querySelector('.ui-tool-call')).toBeNull()
  })

  it('a dangling cause costs the turn that block and nothing else', () => {
    // The command is older than the page limit, or retention took it. The
    // turn still draws the call line it made and both of its fragments, and
    // every block the page DOES hold is still drawn.
    const page: RestorableBlock[] = [
      block('turn-1', QUESTION, 'agent'),
      block('typed-1', 'git status', 'shell'),
    ]
    const root = draw(
      page,
      (id) =>
        id === 'turn-1'
          ? [
              actionCause('act-0', 0, 'readScreen', 0, null),
              shellCause('evicted-1', 1, BEFORE.length),
            ]
          : [],
      ANSWER,
    )
    expect(documentOrder(root)).toEqual([
      `ask:${QUESTION}`,
      `ask:${QUESTION}`,
      'command:git status',
    ])
    expect(root.querySelector('.ui-tool-call__tool')?.textContent).toBe('readScreen')
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

function shellCause(entryId: string, position: number, at: number): RestoredCause {
  return {
    entryId,
    position,
    at,
    kind: 'shell',
    intent: 'cmd',
    effect: null,
    resource: null,
    opensBlock: false,
  }
}

function actionCause(
  entryId: string,
  position: number,
  intent: string,
  at: number,
  resource: { kind: string; id: string } | null,
  opensBlock = false,
): RestoredCause {
  return {
    entryId,
    position,
    at,
    kind: 'action',
    intent,
    effect: opensBlock ? 'mutate-destructive' : 'observe',
    resource: resource,
    opensBlock,
  }
}

/** Draw a restored page the way the pane does (terminal-content.restorePast):
 *  the relation places, a turn becomes its fragments with the blocks it
 *  caused between them, and a block a turn placed is not drawn twice. */
function draw(
  page: RestorableBlock[],
  causesOf: (entryId: string) => RestoredCause[],
  answer: string,
): HTMLElement {
  const root = document.createElement('div')
  const store = new CommandSnapshotStore()
  const container = () => document.createElement('div')
  const byID = new Map(page.map((b) => [b.entryId, b]))
  let id = 100
  const isTurn = (b: RestorableBlock) => b.entryId.startsWith('turn')
  const factsOf = (b: RestorableBlock) => ({
    command: b.command,
    cwd: b.cwd,
    location: b.host,
    durationMs: b.durationMs,
    exitCode: b.exitCode,
    status: b.status,
    body: isTurn(b) ? answer : 'out',
    author: b.author,
    kind: isTurn(b) ? ('ask' as const) : ('command' as const),
    entryId: b.entryId,
  })
  const placed = new Set<string>()
  for (const b of arrangedByCause(page, causesOf)) {
    if (placed.has(b.entryId)) continue
    placed.add(b.entryId)
    if (!isTurn(b)) {
      root.appendChild(restoredBlock({ ...factsOf(b), id: id++ }, S, container, () => {}, store))
      continue
    }
    for (const el of restoredTurn(
      { ...factsOf(b), causes: causesOf(b.entryId) },
      S,
      () => id++,
      container,
      () => {},
      store,
      (entryId) => {
        const caused = byID.get(entryId)
        if (!caused || placed.has(entryId)) return null
        placed.add(entryId)
        return restoredBlock({ ...factsOf(caused), id: id++ }, S, container, () => {}, store)
      },
    )) {
      root.appendChild(el)
    }
  }
  return root
}
