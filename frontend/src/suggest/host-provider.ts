// The host provider (bead nocx-n9i6): `ssh <TAB>` offers the hosts the
// quick-connect picker shows — the same profiles-plus-aliases assembly,
// ROUTED not rebuilt. The quick-connect providers already do the dedup (an
// alias covered by a saved profile is suppressed, because the profile is
// ours and wins) and the degraded-resolver surfacing (when `ssh -G` cannot
// answer, the picker says so instead of showing an empty list); completion
// instantiates them read-only and reads their labels. Two derivations of
// "which hosts do I know" would drift, and the completion popup's copy would
// be the one nobody notices is stale — so there is only the picker's.
//
// This module imports the quick-connect UI module, which is DOM-bound
// (solid-js/web's delegateEvents runs at module scope), so it can only be
// loaded in a DOM context: its tests are jsdom, and the composition root
// (terminal-content.ts) is browser/jsdom-only. providers.ts never imports
// it — the host provider is INJECTED there. The coordinator is sequencing
// lifting the assembly into a shared non-UI module; until then this is the
// single derivation's read-only consumer.
import { SSHQuickConnectProvider, SSHAliasQuickConnectProvider } from '../quick-connect'
import type { QuickConnectItem } from '../quick-connect'
import type { ProfileClient } from '../profiles'
import type { Candidate, CandidateRange } from './candidate'
import type { SuggestionProvider } from './providers'
import { commandWord } from './providers'

/** The item id the quick-connect alias provider emits when `ssh -G` cannot
 *  answer (quick-connect.tsx). The completion reads the degraded condition
 *  back off that row instead of re-deriving it. */
const ALIASES_UNAVAILABLE_ID = '__ssh_aliases_unavailable__'
/** The label prefix that row carries (`SSH config: ${reason}`). The reason
 *  code is not a field on the item, so it is recovered from the label — the
 *  coupling the shared assembly module will remove. */
const UNAVAILABLE_LABEL_PREFIX = 'SSH config: '

/**
 * Where the query sits in a host label, or null when it does not match.
 *
 * The query is a PREFIX — of the label itself (the user part of a
 * `user@host` label, or the whole label) or of the bare host (the part
 * `ssh` addresses): `ssh myh` against `root@myhost` marks the `myh` inside
 * the label, never a mid-word substring. An empty token (a fresh word after
 * `ssh `) is an unconditional match marked as a zero-width range at the
 * start — the shape ghost text and the dropdown both expect for a
 * prefix-free row.
 */
function hostMatchRanges(label: string, query: string): CandidateRange[] | null {
  if (query === '') return [{ from: 0, to: 0 }]
  const userAt = label.startsWith(query) ? 0 : -1
  const at = userAt >= 0 ? userAt : hostPartAt(label, query)
  if (at < 0) return null
  return [{ from: at, to: at + query.length }]
}

/** The offset of a prefix match against the bare host of a `user@host`
 *  label — the part after the LAST `@` — or -1. A label without a user is
 *  its own host, already covered by the label-prefix check above. */
function hostPartAt(label: string, query: string): number {
  const at = label.lastIndexOf('@')
  if (at < 0) return -1
  const host = label.slice(at + 1)
  return host.startsWith(query) ? at + 1 : -1
}

/** The reason code off the degraded row's label — the item carries it only
 *  there (`SSH config: ${reason}`, quick-connect.tsx); the whole label is
 *  the fallback if that format ever changes. */
function degradedReason(item: QuickConnectItem): string {
  return item.label.startsWith(UNAVAILABLE_LABEL_PREFIX)
    ? item.label.slice(UNAVAILABLE_LABEL_PREFIX.length)
    : item.label
}

export function hostProvider(opts: { profileClient: ProfileClient }): SuggestionProvider {
  // The picker's assembly, instantiated read-only: completion never
  // activates an item (no tab is opened from a completion), so the run
  // callbacks are unreachable and say so.
  const neverRun = (): never => {
    throw new Error('a completion host item is never activated')
  }
  const profiles = new SSHQuickConnectProvider(opts.profileClient, neverRun)
  const aliases = new SSHAliasQuickConnectProvider(opts.profileClient, neverRun)
  return {
    id: 'host',
    targetId: 'shell',
    // Applicable only where a host is the answer: the `ssh` command's
    // argument position — never command position, never another command's
    // arguments, and never a path form (`ssh some/path` completes a path
    // argument, which the path provider owns).
    applicable: (ctx) =>
      ctx.position === 'argument' && commandWord(ctx) === 'ssh' && !ctx.token.text.includes('/'),
    async suggest(ctx, signal) {
      const [profileItems, aliasItems] = await Promise.all([
        profiles.getItems(),
        aliases.getItems(),
      ])
      if (signal.aborted) return { candidates: [] }

      // The degraded-resolver row is the condition, not a host: it is
      // surfaced as the empty reason when nothing else answered, and never
      // offered as a candidate (profiles still answer on their own).
      const degraded = aliasItems.find((it) => it.id === ALIASES_UNAVAILABLE_ID)
      const rows = degraded === undefined ? aliasItems : aliasItems.filter((it) => it !== degraded)

      const candidates: Candidate[] = []
      for (const item of [...profileItems, ...rows]) {
        const matchRanges = hostMatchRanges(item.label, ctx.token.text)
        if (matchRanges === null) continue
        candidates.push({
          // The item's own id (a profile id, or `__ssh_alias:<alias>`) is
          // the stable identity the merge dedups on — unique across both
          // halves, and the same host can never read alike twice.
          id: `host:${item.id}`,
          targetId: 'shell',
          providerId: 'host',
          // The picker's label IS the completion's text: what quick-connect
          // shows (`user@host`, or the alias) is exactly what `ssh` takes.
          displayText: item.label,
          insertText: item.label,
          replacement: { from: ctx.token.from, to: ctx.token.to },
          matchRanges,
          source: 'host',
          eligibleForGhostText: true,
        })
      }
      if (candidates.length > 0 || degraded === undefined) return { candidates }
      return {
        candidates: [],
        emptyReason: {
          kind: 'hosts-unavailable',
          reason: degradedReason(degraded),
          detail: degraded.detail ?? '',
        },
      }
    },
  }
}
