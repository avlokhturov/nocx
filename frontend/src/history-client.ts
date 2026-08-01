// The one frontend seam that ships command history over the control plane
// (nocx-rtg0.13, AD-1 as amended by nocx-m64b). The renderer owns the VT
// state (AD-6) and derives the facts of a completed command from it; these
// two functions are where those facts cross — a small structured record
// after the fact, never a copy of the output. When a fuller event envelope
// lands (nocx-rtg0.3), only this module changes: the ledger and the recall
// overlay call here and nowhere else.

import type { CommandRecord } from './command-ledger'
import type { HistoryQuery } from './generated/history.query'
import type { WSClient } from './ipc'
import type { RecallScope } from './recall'

/** The history.record request — the ledger's facts minus what never crosses
 *  (the session-local id, the live marker-line accessor, the disposed flag)
 *  and minus the output, which is never retained (ADR-0008). */
export interface HistoryRecordParams {
  command: string
  cwd: string
  host: string
  status: CommandRecord['status']
  exitCode: number | null
  startedAt: number | null
  endedAt: number | null
  trusted: boolean
}

/** Send one completed command's facts to the store. Best-effort by design: a
 *  socket drop or an unavailable store loses the entry for this session —
 *  the honest cost of not blocking the terminal — and the recall overlay
 *  still answers from the session ledger until the store comes back. */
export function recordCommand(client: WSClient, rec: CommandRecord): void {
  const params: HistoryRecordParams = {
    command: rec.command,
    cwd: rec.cwd,
    host: rec.host,
    status: rec.status,
    exitCode: rec.exitCode,
    // The ledger clocks performance.now(), which is a float; the store
    // persists int64 (the schema says integer), so the wire copy rounds.
    startedAt: rec.startedAt === null ? null : Math.round(rec.startedAt),
    endedAt: rec.endedAt === null ? null : Math.round(rec.endedAt),
    trusted: rec.trusted,
  }
  void client.call<Record<string, never>>('history.record', params).catch(() => {
    // Fire-and-forget: a dropped record is a session-lost entry, never a
    // crash. The recall panel's source label tells the truth either way.
  })
}
export async function queryHistory(
  client: WSClient,
  scope: RecallScope,
  cwd: string,
  host: string,
): Promise<HistoryQuery> {
  const params: Record<string, unknown> = { scope }
  if (scope === 'directory') {
    params.cwd = cwd
    params.host = host
  } else if (scope === 'host') {
    params.host = host
  }
  return client.call<HistoryQuery>('history.query', params)
}
