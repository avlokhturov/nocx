// Reading a pane's past back (nocx-m3fqk, design §5 and §6).
//
// Two reads, and the split is ADR-0019 §6's: the page carries what a block is
// (command, directory, outcome) and never its bytes, and the body of each
// block is fetched one at a time by the thing that is about to draw it. A
// restore that hauled every body in the page would read a megabyte to paint
// fifty headers.
//
// WHAT THIS DOES NOT DO: decide anything. The order is the ledger's — seq
// DESC, the one total order — and this reverses the page for drawing because
// a person reads their past downwards. Nothing here filters, ranks or
// merges.
import type { WSClient } from './ipc'
import type { LedgerQuery } from './generated/ledger.query'
import type { LedgerArtifact } from './generated/ledger.artifact'
import type { LedgerGet } from './generated/ledger.get'

/** How many blocks a pane comes back with.
 *
 *  Fifty rather than everything: eight panes at fifty is four hundred blocks
 *  of DOM, and the scrollback a person actually scrolls through is the recent
 *  end of it. Older commands are not lost — they are in recall, which is
 *  where a question about last week belongs. */
const RESTORE_BLOCK_LIMIT = 50

/** One block to draw, as the store knows it. The body is fetched separately;
 *  `null` means there is none to show, which is a hole and not silence. */
export interface RestorableBlock {
  entryId: string
  command: string
  cwd: string
  /** The host the command ran on, '' for the local machine. A block keeps
   *  saying where it ran even when the pane is local again — which is what
   *  makes an inline ssh honest without any code of its own (design §7). */
  host: string
  status: 'success' | 'failure' | 'entered' | 'unknown'
  durationMs: number
  exitCode: number | null
}

/** The ledger's status vocabulary, narrowed to what a frozen block draws.
 *  A restored entry that never closed is `unknown`, which is exactly what an
 *  abandoned attempt renders as — the block says "this did not finish", and
 *  it did not. */
function frozenStatus(status: string): RestorableBlock['status'] {
  switch (status) {
    case 'success':
      return 'success'
    case 'failure':
      return 'failure'
    case 'interrupted':
      return 'unknown'
    default:
      return 'unknown'
  }
}

/**
 * The blocks this pane had, oldest first — the order they are drawn in.
 *
 * THROWS when the store could not be asked, and that is the whole point of
 * not catching here. "This pane had no blocks" and "nobody could tell me"
 * are different answers, and the caller has to act differently on them: the
 * first is final, the second must be tried again when the socket is back
 * (AD-9 — a reconnect is ordinary, and a pane that restored during one would
 * otherwise show an empty past for the rest of the session).
 */
export async function blocksForPane(client: WSClient, paneId: string): Promise<RestorableBlock[]> {
  const page = await client.call<LedgerQuery>('ledger.query', {
    scope: 'everywhere',
    paneId,
    limit: RESTORE_BLOCK_LIMIT,
  })
  return page.entries
    .map((e) => ({
      entryId: e.id,
      command: e.intent,
      cwd: e.cwd,
      host: e.host ?? '',
      status: frozenStatus(e.status),
      durationMs: e.durationMs ?? 0,
      exitCode: e.exitCode,
    }))
    .reverse()
}

/**
 * The body one block printed, or null when there is none to show.
 *
 * NULL IS TWO DIFFERENT FACTS and the caller renders both the same way, which
 * is correct: retention evicted the artifact, or the store could not be
 * reached. Either way the honest answer on screen is "the output is not
 * here", never an empty block that reads as a command which printed nothing.
 */
export async function bodyForBlock(client: WSClient, entryId: string): Promise<string | null> {
  try {
    const entry = await client.call<LedgerGet>('ledger.get', { id: entryId })
    // The SGR body is what a block draws. The derived text/plain artifact
    // beside it is for search and copy, and drawing that one would silently
    // throw the colour away.
    const vt = entry.artifacts.find((a) => a.mediaType === 'application/vt')
    if (!vt) return null
    const body = await client.call<LedgerArtifact>('ledger.artifact', { id: vt.id })
    return body.body
  } catch {
    // Quiet by design: a pane restoring fifty blocks would otherwise log
    // fifty times for one store that is down, and the caller already says
    // once, in the product, that history is unavailable.
    return null
  }
}
