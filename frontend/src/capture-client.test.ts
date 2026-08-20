import { describe, it, expect, vi } from 'vitest'
import {
  captureBlock,
  capBody,
  chunksOf,
  CHUNK_BYTES,
  DEFAULT_CAP_BYTES,
  type CapturedBody,
} from './capture-client'

const utf8 = (s: string) => new TextEncoder().encode(s).length

describe('capBody', () => {
  it('leaves a body under the cap alone', () => {
    expect(capBody('small', DEFAULT_CAP_BYTES)).toEqual({ text: 'small', truncated: null })
  })

  it('keeps the head and the tail and drops the middle', () => {
    const body = 'H'.repeat(200) + 'M'.repeat(500) + 'T'.repeat(200)
    const { text, truncated } = capBody(body, 400)
    expect(truncated).toBe('cap')
    expect(text.startsWith('H')).toBe(true)
    expect(text.endsWith('T')).toBe(true)
    expect(text).not.toContain('M')
    expect(utf8(text)).toBeLessThanOrEqual(400)
  })

  it('never splits a character in half', () => {
    // 'ы' is two bytes, so an odd byte budget lands mid-character unless the
    // cut walks back off the continuation byte.
    const body = 'ы'.repeat(100)
    const { text } = capBody(body, 51)
    expect(text).not.toContain('�')
    expect(utf8(text)).toBeLessThanOrEqual(51)
  })
})

describe('chunksOf', () => {
  it('returns one chunk for an empty body, so an empty output is still an artifact', () => {
    expect(chunksOf('')).toEqual([''])
  })

  it('splits at the wire ceiling and the parts rejoin exactly', () => {
    const big = 'x'.repeat(CHUNK_BYTES + 10)
    const parts = chunksOf(big)
    expect(parts.length).toBe(2)
    expect(parts.join('')).toBe(big)
    for (const p of parts) expect(utf8(p)).toBeLessThanOrEqual(CHUNK_BYTES)
  })

  it('splits a multi-byte body without producing a broken character', () => {
    const big = 'ы'.repeat(CHUNK_BYTES) // twice the ceiling in bytes
    const parts = chunksOf(big)
    expect(parts.join('')).toBe(big)
    for (const p of parts) {
      expect(p).not.toContain('�')
      expect(utf8(p)).toBeLessThanOrEqual(CHUNK_BYTES)
    }
  })
})

/** What one ledger.capture request carries — declared so the assertions read
 *  a typed params object rather than indexing into `any`. */
interface SentCapture {
  entryId: string
  artifactId: string
  mediaType: string
  derivedFrom: string | null
  truncated: string | null
  captureVersion: number
  terminalCols: number
  terminalRows: number
  seq: number
  body: string
}

const sent = (call: ReturnType<typeof vi.fn>): SentCapture[] =>
  call.mock.calls.map((c) => c[1] as SentCapture)

const aBody = (over: Partial<CapturedBody> = {}): CapturedBody => ({
  sgr: '\x1b[31mred\x1b[0m',
  text: 'red',
  cols: 80,
  rows: 24,
  ...over,
})

describe('captureBlock', () => {
  const ok = () => vi.fn().mockResolvedValue({ artifactId: 'a', stored: true })

  it('sends the vt body first and derives the text body from it', async () => {
    const call = ok()
    await captureBlock({ call } as never, 'entry-1', aBody(), DEFAULT_CAP_BYTES)
    const calls = sent(call)
    expect(calls.map((c) => c.mediaType)).toEqual(['application/vt', 'text/plain'])
    expect(calls[1].derivedFrom).toBe(calls[0].artifactId)
    expect(calls[0].derivedFrom).toBe(null)
  })

  it('carries the provenance the serializer saw', async () => {
    const call = ok()
    await captureBlock(
      { call } as never,
      'entry-1',
      aBody({ cols: 120, rows: 40 }),
      DEFAULT_CAP_BYTES,
    )
    const p = sent(call)[0]
    expect(p.terminalCols).toBe(120)
    expect(p.terminalRows).toBe(40)
    expect(p.captureVersion).toBeGreaterThanOrEqual(1)
    expect(p.entryId).toBe('entry-1')
  })

  it('numbers the parts of a long body from one and they rejoin', async () => {
    const call = ok()
    const big = 'x'.repeat(CHUNK_BYTES + 10)
    await captureBlock(
      { call } as never,
      'entry-1',
      aBody({ sgr: big, text: big }),
      DEFAULT_CAP_BYTES,
    )
    const vt = sent(call).filter((c) => c.mediaType === 'application/vt')
    expect(vt.map((c) => c.seq)).toEqual([1, 2])
    expect(vt.map((c) => c.body).join('')).toBe(big)
  })

  it('says the body was capped, on both artifacts', async () => {
    const call = ok()
    const long = 'y'.repeat(1000)
    await captureBlock({ call } as never, 'entry-1', aBody({ sgr: long, text: long }), 400)
    for (const c of sent(call)) expect(c.truncated).toBe('cap')
  })

  it('stops when the store says the body is not kept', async () => {
    const call = vi.fn().mockResolvedValue({ artifactId: 'a', stored: false })
    await captureBlock({ call } as never, 'entry-1', aBody(), DEFAULT_CAP_BYTES)
    // One call, not two artifacts and not the rest of the chunks: retention
    // is off, and pushing a body nobody stores is work for both ends.
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('loses the body rather than the block when a call fails', async () => {
    const call = vi.fn().mockRejectedValue(new Error('socket gone'))
    await expect(
      captureBlock({ call } as never, 'entry-1', aBody(), DEFAULT_CAP_BYTES),
    ).resolves.toBeUndefined()
  })
})
