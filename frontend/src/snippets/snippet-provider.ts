// Snippets in the ONE dropdown (design §10.2, bead nocx-nlhe) — a
// SuggestionProvider beside the command, history, path and host ones, not a
// second suggestion surface. The last time this feature area grew a surface
// of its own it had to be deleted: a whole parallel list with its own keys,
// rendering and accept path, which un-suppressed itself at the one keystroke
// where it disagreed with the completion dropdown (AGENTS.md, the ssh
// predicate).
//
// Two rules this provider states in its candidates and nowhere else:
//
//  - `eligibleForGhostText: false`, always. A body with `ask:` spans needs a
//    form, and a form cannot run inside text that types itself ahead of the
//    caret. §10.2 disables the ghost; it does not remove the row.
//  - `insertText` is the TITLE, not the body. Resolution happens at
//    ACCEPTANCE (design §8: once, at fire time), so nothing here may bake in
//    a cwd or a branch that can be stale by the time Enter is pressed — and
//    the ranking's exact-match rung reads exactly this field, so a body here
//    would let a snippet claim an exact match on text nobody typed.
import type { Candidate } from '../suggest/candidate'
import type { SuggestBatch, SuggestContext, SuggestionProvider } from '../suggest/providers'
import type { Snippet } from './snippets-store'

/** Same per-provider cap the shipped providers use — imported rather than
 *  restated so one number governs the dropdown's length. */
import { MAX_PROVIDER_CANDIDATES } from '../suggest/providers'

export interface SnippetProviderDeps {
  /** The library as it stands — read synchronously, because a provider
   *  answers a keystroke. */
  snippets: () => readonly Snippet[]
  /** Ask the store to read the library if it has not yet. Called at most
   *  once per unread library: a wire call per keystroke would be a query
   *  storm for a list that changes when a person edits it. */
  ensureLoaded: () => void
}

export function snippetProvider(deps: SnippetProviderDeps): SuggestionProvider {
  return {
    id: 'snippet',
    targetId: 'shell',
    // Command position and a bare word — the same gate the command provider
    // declares. A snippet is a phrase you run, so it belongs where a
    // command name belongs, and a token with a slash is a path invocation.
    applicable: (ctx: SuggestContext) =>
      ctx.position === 'command' && !ctx.token.text.includes('/'),
    suggest(ctx: SuggestContext): SuggestBatch {
      const q = ctx.token.text
      if (q === '') return { candidates: [] }
      deps.ensureLoaded()
      const needle = q.toLowerCase()
      const matched = deps
        .snippets()
        .filter((s) => s.title.toLowerCase().startsWith(needle))
        .slice(0, MAX_PROVIDER_CANDIDATES)
      return {
        candidates: matched.map((s): Candidate => ({
          id: `snippet:${s.id}`,
          targetId: 'shell',
          providerId: 'snippet',
          displayText: s.title,
          insertText: s.title,
          snippetId: s.id,
          replacement: { from: ctx.token.from, to: ctx.token.to },
          matchRanges: [{ from: 0, to: q.length }],
          source: 'snippet',
          eligibleForGhostText: false,
        })),
      }
    },
  }
}
