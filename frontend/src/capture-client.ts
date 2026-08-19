// The capture half of "a block keeps what it printed" (nocx-2f0f, design §4).
//
// Two artifacts per frozen block: the SGR body, which is what a restore
// draws, and the plain body derived from it, which is what search and copy
// read. The vt one goes first because the text one names it in derivedFrom,
// and a derived body pointing at nothing has lost the provenance that made it
// worth deriving.
//
// BEST-EFFORT, ALWAYS. A capture that fails costs the block's body and
// nothing else — never the entry, never the block on screen, never an error
// in front of the person. That is the contract recordCommand already has, for
// the same reason: the command has already run.
import type { WSClient } from './ipc'
import type { LedgerCapture } from './generated/ledger.capture'
import { SERIALIZER_VERSION } from './scrollback/serializer'
import { uuidv7 } from './layout/uuid7'
import { log } from './log'

/** The transport's own per-message ceiling, matched here so a body is split
 *  before it is refused rather than after (ws_ledger_capture.go). */
export const CHUNK_BYTES = 64 * 1024

/** What one command's body may be worth by default, in bytes — the head and
 *  the tail of it. The user's own number arrives with the setting; this is
 *  what applies until it does. */
export const DEFAULT_CAP_BYTES = 256 * 1024

/** What a frozen block kept, as the serializer produced it. */
export interface CapturedBody {
  /** The rows with their SGR attributes: the durable body. */
  sgr: string
  /** The same rows as characters: the derived body. */
  text: string
  /** The grid the serializer saw, recorded as capture provenance. */
  cols: number
  rows: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Cut a UTF-8 buffer at `at` without splitting a character: walk back off
 *  any continuation byte (10xxxxxx). A cut in the middle of one decodes to
 *  U+FFFD, which is a character the program never printed. */
function backOffContinuation(bytes: Uint8Array, at: number): number {
  let i = Math.min(at, bytes.length)
  while (i > 0 && (bytes[i] & 0xc0) === 0x80) i--
  return i
}

function headBytes(bytes: Uint8Array, n: number): string {
  return decoder.decode(bytes.subarray(0, backOffContinuation(bytes, n)))
}

function tailBytes(bytes: Uint8Array, n: number): string {
  const start = backOffContinuation(bytes, Math.max(0, bytes.length - n))
  return decoder.decode(bytes.subarray(start))
}

/**
 * Bound one body: the head and the tail are kept, the middle is dropped, and
 * the artifact says `cap` (design §4.3).
 *
 * A cap on BYTES rather than on lines is what bounds the budget almost
 * independently of what the user runs. Errors live in the tail and the
 * invocation and its first diagnostics in the head; a million lines of
 * progress bar between them are of no value to anyone.
 */
export function capBody(text: string, capBytes: number): { text: string; truncated: 'cap' | null } {
  const bytes = encoder.encode(text)
  if (bytes.length <= capBytes) return { text, truncated: null }
  const half = Math.floor(capBytes / 2)
  return { text: headBytes(bytes, half) + tailBytes(bytes, capBytes - half), truncated: 'cap' }
}

/**
 * Split a body into messages the transport will accept.
 *
 * An EMPTY body is one empty chunk, not none: a command that printed nothing
 * still has a body, and an artifact with no chunks would be indistinguishable
 * from a capture that never arrived.
 */
export function chunksOf(text: string): string[] {
  const bytes = encoder.encode(text)
  if (bytes.length <= CHUNK_BYTES) return [text]
  const parts: string[] = []
  let at = 0
  while (at < bytes.length) {
    const end = backOffContinuation(bytes, Math.min(at + CHUNK_BYTES, bytes.length))
    parts.push(decoder.decode(bytes.subarray(at, end)))
    at = end
  }
  return parts
}

interface CaptureParams {
  entryId: string
  artifactId: string
  mediaType: 'application/vt' | 'text/plain'
  derivedFrom: string | null
  truncated: 'cap' | null
  captureVersion: number
  terminalCols: number
  terminalRows: number
  seq: number
  body: string
}

/** Send one artifact, chunk by chunk. Answers its id, or null when the store
 *  said the body is not being kept — which is not a failure and stops the
 *  rest of the send. */
async function sendArtifact(
  client: WSClient,
  entryId: string,
  mediaType: 'application/vt' | 'text/plain',
  body: { text: string; truncated: 'cap' | null },
  dims: { cols: number; rows: number },
  derivedFrom: string | null,
): Promise<string | null> {
  const artifactId = uuidv7()
  const parts = chunksOf(body.text)
  for (let i = 0; i < parts.length; i++) {
    const params: CaptureParams = {
      entryId,
      artifactId,
      mediaType,
      derivedFrom,
      truncated: body.truncated,
      captureVersion: SERIALIZER_VERSION,
      terminalCols: dims.cols,
      terminalRows: dims.rows,
      seq: i + 1,
      body: parts[i],
    }
    const ack = await client.call<LedgerCapture>('ledger.capture', params)
    if (!ack.stored) return null
  }
  return artifactId
}

/**
 * Send one frozen block's bodies against the entry the record ack named.
 *
 * Sequential rather than parallel, and that is not caution: the text body
 * names the vt body in derivedFrom, so it cannot be sent before the vt one
 * has an id, and the chunks of one artifact are numbered in order for a
 * reader that joins them.
 */
export async function captureBlock(
  client: WSClient,
  entryId: string,
  body: CapturedBody,
  capBytes: number = DEFAULT_CAP_BYTES,
): Promise<void> {
  try {
    const dims = { cols: body.cols, rows: body.rows }
    const vtID = await sendArtifact(
      client,
      entryId,
      'application/vt',
      capBody(body.sgr, capBytes),
      dims,
      null,
    )
    if (vtID === null) return
    await sendArtifact(client, entryId, 'text/plain', capBody(body.text, capBytes), dims, vtID)
  } catch (err) {
    log.warn('nocx: the block body was not captured', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
