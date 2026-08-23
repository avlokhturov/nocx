// One fetch path, two media types (nocx-v13pd).
//
// A block's body and an answer's text are the SAME two round trips —
// ledger.get for the entry, ledger.artifact for the payload — differing only
// in which artifact of the entry is asked for. A second fetch path would be
// two answers to one question, and they would agree until the day the
// artifact list changed shape.
import { describe, it, expect, vi } from 'vitest'
import { answerTextForEntry, blocksForPane, bodyForBlock, restoredBody } from './restore-client'
import type { WSClient } from './ipc'

/** A ledger that answers `ledger.get` with one entry's artifact list and
 *  `ledger.artifact` with the bytes of whichever id was asked for. */
function fakeLedger(artifacts: Array<{ id: string; mediaType: string; body: string }>) {
  const calls: Array<{ method: string; params: unknown }> = []
  const client = {
    call: vi.fn((method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'ledger.get') {
        return Promise.resolve({
          artifacts: artifacts.map((a) => ({ id: a.id, mediaType: a.mediaType })),
        })
      }
      const found = artifacts.find((a) => a.id === (params as { id: string }).id)
      return Promise.resolve({ body: found?.body ?? '' })
    }),
  } as unknown as WSClient
  return { client, calls }
}

/** The SGR body, with its escapes written AS escapes: a literal control byte
 *  in a fixture is a byte the next editor silently eats. */
const SGR_BODY = `\u001b[32mok\u001b[0m`
const ANSWER_TEXT = '## Findings\n- run `ls`\n'

const BOTH = [
  { id: 'art-vt', mediaType: 'application/vt', body: SGR_BODY },
  { id: 'art-txt', mediaType: 'text/plain', body: ANSWER_TEXT },
]

describe('restore-client — one helper, two media types', () => {
  it('a block body is the SGR artifact — the colour is what a block draws', async () => {
    const { client } = fakeLedger(BOTH)
    expect(await bodyForBlock(client, 'entry-1')).toBe(SGR_BODY)
  })

  it("an answer's text is the text/plain artifact, byte for byte", async () => {
    const { client, calls } = fakeLedger(BOTH)
    expect(await answerTextForEntry(client, 'entry-1')).toBe(ANSWER_TEXT)
    // Two round trips and no more: the entry, then the one artifact.
    expect(calls.map((c) => c.method)).toEqual(['ledger.get', 'ledger.artifact'])
    expect(calls[1].params).toEqual({ id: 'art-txt' })
  })

  it('answers null when the entry has no artifact of that type — retention took it', async () => {
    const { client } = fakeLedger([BOTH[0]])
    expect(await answerTextForEntry(client, 'entry-1')).toBeNull()
    const other = fakeLedger([BOTH[1]])
    expect(await bodyForBlock(other.client, 'entry-1')).toBeNull()
  })

  it('answers null when the store cannot be reached at all', async () => {
    const client = {
      call: vi.fn(() => Promise.reject(new Error('socket closed'))),
    } as unknown as WSClient
    expect(await answerTextForEntry(client, 'entry-1')).toBeNull()
    expect(await bodyForBlock(client, 'entry-1')).toBeNull()
  })
})

// ── what a restored entry IS, read from its body (nocx-4em1z) ─────────────
//
// The restore path has to pick a block's grammar — a terminal grid must not
// re-wrap, prose must — and the fact it picks from is STORED rather than
// inferred: a command's body is `application/vt` (its plain copy beside it is
// marked derived from that one), and an assistant turn's body is a
// `text/plain` original with no terminal body at all, ever.
//
// So this is not sniffing. It is asking the entry what it has.
describe('restore-client — a block says what it is by what its body is', () => {
  it('a terminal body makes it a command block, and the body is the SGR one', async () => {
    const { client } = fakeLedger(BOTH)
    expect(await restoredBody(client, 'entry-1')).toEqual({ kind: 'command', body: SGR_BODY })
  })

  it('no terminal body makes it an assistant turn, drawn from its text', async () => {
    const { client } = fakeLedger([BOTH[1]])
    expect(await restoredBody(client, 'entry-1')).toEqual({ kind: 'ask', body: ANSWER_TEXT })
  })

  it('a turn whose answer is gone is still a turn — the kind does not follow the loss', async () => {
    // Retention takes bodies and leaves entries (ADR-0019 §7). An entry with
    // NO artifact at all is the one case the body cannot answer, and the
    // honest reading is the command grammar it has always had: a turn that
    // lost its answer would say "no longer kept" either way, and inventing
    // prose for an empty entry would repaint every evicted command.
    const { client } = fakeLedger([])
    expect(await restoredBody(client, 'entry-1')).toEqual({ kind: 'command', body: null })
  })

  it('says nothing about the kind it cannot know when the store is unreachable', async () => {
    const client = {
      call: vi.fn(() => Promise.reject(new Error('socket closed'))),
    } as unknown as WSClient
    expect(await restoredBody(client, 'entry-1')).toEqual({ kind: 'command', body: null })
  })
})

// ── who wrote it, and what is a block at all (nocx-4em1z) ─────────────────
describe('restore-client — the pane read', () => {
  /** A ledger.query answering with one page of entries. */
  function fakeQuery(entries: Array<Record<string, unknown>>) {
    const client = {
      call: vi.fn(() => Promise.resolve({ entries })),
    } as unknown as WSClient
    return client
  }

  const entry = (over: Record<string, unknown>) => ({
    id: 'e1',
    intent: 'ls',
    cwd: '/repo',
    host: null,
    kind: 'shell',
    status: 'success',
    durationMs: 10,
    exitCode: 0,
    ...over,
  })

  it("carries the entry's author, so a command the assistant ran keeps its badge", async () => {
    const client = fakeQuery([entry({ id: 'agent-cmd', kind: 'agent', intent: 'go test ./...' })])
    const [block] = await blocksForPane(client, 'pane-1')
    expect(block.author).toBe('agent')
    expect(block.command).toBe('go test ./...')
  })

  it('a command a person typed is authored by the shell', async () => {
    const client = fakeQuery([entry({})])
    const [block] = await blocksForPane(client, 'pane-1')
    expect(block.author).toBe('shell')
  })

  it('an action is not a block and never becomes one', async () => {
    // A tool call is recorded, and it is an element of a turn's flow rather
    // than a block in the ledger's own words: 'an action has no block and no
    // command line' (command-ledger.ts). Restoring one as a top-level block
    // would put a second owner beside the tool-call line the answer already
    // draws.
    const client = fakeQuery([
      entry({ id: 'act', kind: 'action', intent: 'readScreen' }),
      entry({ id: 'cmd' }),
    ])
    const blocks = await blocksForPane(client, 'pane-1')
    expect(blocks.map((b) => b.entryId)).toEqual(['cmd'])
  })
})
