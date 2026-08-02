// The three shipped providers (design §8.4, §8.5) — command names from the
// OSC 636 snapshot, history over the control plane, and local filesystem
// paths. Applicability is part of the contract: a provider declares where it
// applies and is not consulted outside it. In particular the local path
// provider is inactive on a remote session and for bare words — a local path
// must never masquerade as a remote one, and a bare word is a command name,
// not a path.
import type { CommandSnapshotStore } from '../command-snapshot'
import type { HistoryQuery } from '../generated/history.query'
import type { FsComplete } from '../generated/fs.complete'
import type { Candidate } from './candidate'
import type { CompletionToken } from './token'

/** Per-provider cap on the candidates returned to the merge. */
export const MAX_PROVIDER_CANDIDATES = 20

/** Everything a provider needs to answer one query. */
export interface SuggestContext {
  /** The whole document line. */
  readonly doc: string
  /** The word being completed ('' at a boundary). */
  readonly token: CompletionToken
  /** Where the token sits — command vs argument position. */
  readonly position: 'command' | 'argument'
  /** The tab's session is a local shell (the path provider's hard gate). */
  readonly isLocal: boolean
  /** The session's working directory, '' when unknown (no OSC 7 yet). */
  readonly cwd: string
  /** The session host, '' for the local machine (matches history rows). */
  readonly host: string
}

export interface SuggestionProvider {
  readonly id: string
  readonly targetId: string
  /** Declared applicability: not consulted outside it (design §8.5). */
  applicable(ctx: SuggestContext): boolean
  /** May resolve synchronously — the in-memory command provider has nothing
   *  to await, and a microtask per keystroke is a waste. */
  suggest(ctx: SuggestContext, signal: AbortSignal): Promise<Candidate[]> | Candidate[]
}

// ── command: the OSC 636 snapshot ────────────────────────────────────────
//
// The snapshot is the running shell's own answer (command-snapshot.ts), so it
// is correct on a remote host too — which is exactly what the path provider
// is not. Applicable only in command position, and only for a bare word: a
// token containing a slash is a path invocation (`./run.sh`), which the path
// provider owns.
export function commandProvider(store: CommandSnapshotStore): SuggestionProvider {
  return {
    id: 'command',
    targetId: 'shell',
    applicable: (ctx) => ctx.position === 'command' && !ctx.token.text.includes('/'),
    suggest(ctx) {
      const q = ctx.token.text
      if (q === '') return []
      const names = store.matching(q).slice(0, MAX_PROVIDER_CANDIDATES)
      return names.map((name): Candidate => ({
        id: `cmd:${name}`,
        targetId: 'shell',
        providerId: 'command',
        displayText: name,
        insertText: name,
        replacement: { from: ctx.token.from, to: ctx.token.to },
        matchRanges: [{ from: 0, to: q.length }],
        source: 'command',
        eligibleForGhostText: true,
      }))
    },
  }
}

// ── history: the control plane's history.query ───────────────────────────
//
// Completes the whole line (history-beginning-search semantics): a history
// entry whose command starts with the line replaces the entire line. Rows are
// environment-scoped by the store (the directory rung); the same command
// arriving twice dedups by id, keeping the newest.
export function historyProvider(opts: {
  query: (cwd: string, host: string) => Promise<HistoryQuery>
}): SuggestionProvider {
  return {
    id: 'history',
    targetId: 'shell',
    // Applicable whenever there is a line to complete, even with a trailing
    // space (`git ` + Tab can complete the line to `git status`).
    applicable: (ctx) => ctx.doc.trim() !== '',
    async suggest(ctx, signal) {
      const line = ctx.doc
      if (line === '') return []
      const result = await opts.query(ctx.cwd, ctx.host)
      if (signal.aborted) return []
      const seen = new Set<string>()
      const out: Candidate[] = []
      for (const e of result.entries) {
        // Newest first on the wire; keep the first (newest) of a duplicate.
        if (!e.command.startsWith(line) || seen.has(e.command)) continue
        seen.add(e.command)
        out.push({
          id: `hist:${e.command}`,
          targetId: 'shell',
          providerId: 'history',
          displayText: e.command,
          insertText: e.command,
          replacement: { from: 0, to: line.length },
          matchRanges: [{ from: 0, to: line.length }],
          source: 'history',
          scope: 'directory',
          freshness: e.endedAt ?? undefined,
          // A row still running has no final outcome — never invent one.
          outcome: e.status === 'running' ? undefined : { status: e.status },
          environment: { cwd: e.cwd, host: e.host, confidence: 'asserted' },
          eligibleForGhostText: true,
        })
        if (out.length >= MAX_PROVIDER_CANDIDATES) break
      }
      return out
    },
  }
}

// ── fs: local filesystem paths ───────────────────────────────────────────
//
// The backend (fs.complete) resolves the partial path and lists the directory
// it points at. Applicable only when the session is local — the backend's
// filesystem IS the local machine's, and inside an SSH session that answer
// would be a local path masquerading as a remote one. A bare word is never a
// path; the token must carry a slash, a leading dot, or a tilde.
export function fsProvider(opts: {
  complete: (text: string, cwd: string) => Promise<FsComplete>
}): SuggestionProvider {
  return {
    id: 'fs',
    targetId: 'shell',
    applicable: (ctx) => {
      if (!ctx.isLocal) return false
      const t = ctx.token.text
      return t !== '' && (t.includes('/') || t.startsWith('.') || t.startsWith('~'))
    },
    async suggest(ctx, signal) {
      const q = ctx.token.text
      const result = await opts.complete(q, ctx.cwd)
      if (signal.aborted) return []
      // The part of the token the user has already typed up to the last
      // slash — display and insert both carry it, so accepting a candidate
      // never loses the directory the user already wrote.
      const lastSlash = q.lastIndexOf('/')
      const tokenPrefix = q.slice(0, lastSlash + 1)
      const segPrefix = q.slice(lastSlash + 1)
      return result.entries.slice(0, MAX_PROVIDER_CANDIDATES).map((e): Candidate => {
        const display = tokenPrefix + e.name + (e.isDir ? '/' : '')
        const segStart = display.length - e.name.length - (e.isDir ? 1 : 0)
        return {
          id: `fs:${e.path}`,
          targetId: 'shell',
          providerId: 'fs',
          displayText: display,
          insertText: display,
          replacement: { from: ctx.token.from, to: ctx.token.to },
          matchRanges: [{ from: segStart, to: segStart + segPrefix.length }],
          source: 'path',
          environment: { cwd: ctx.cwd, confidence: 'asserted' },
          eligibleForGhostText: true,
        }
      })
    },
  }
}

/** The shell target's provider set, wired at the composition root. */
export function createShellProviders(opts: {
  store: CommandSnapshotStore
  queryHistory: (cwd: string, host: string) => Promise<HistoryQuery>
  completeFs: (text: string, cwd: string) => Promise<FsComplete>
}): SuggestionProvider[] {
  return [
    commandProvider(opts.store),
    historyProvider({ query: opts.queryHistory }),
    fsProvider({ complete: opts.completeFs }),
  ]
}
