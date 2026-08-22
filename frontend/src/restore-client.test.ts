// One fetch path, two media types (nocx-v13pd).
//
// A block's body and an answer's text are the SAME two round trips —
// ledger.get for the entry, ledger.artifact for the payload — differing only
// in which artifact of the entry is asked for. A second fetch path would be
// two answers to one question, and they would agree until the day the
// artifact list changed shape.
import { describe, it, expect, vi } from 'vitest'
import { answerTextForEntry, bodyForBlock } from './restore-client'
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
