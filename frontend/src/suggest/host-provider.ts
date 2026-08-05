// The host provider (bead nocx-n9i6): `ssh <TAB>` offers the hosts the
// quick-connect picker shows — the same profiles-plus-aliases assembly,
// ROUTED not rebuilt. quick-connect-assembly.ts is the shared non-UI module
// (plain code, no solid-js): quick-connect.tsx renders its rows, completion
// reads them. Two derivations of "which hosts do I know" would drift, and
// the completion popup's copy would be the one nobody notices is stale — so
// there is only the picker's. The degraded-resolver condition is typed data
// on the assembly, never a label to parse: when `ssh -G` cannot answer, it
// is surfaced as the empty reason instead of an empty list.
import { aliasRows, profileRows } from '../quick-connect-assembly'
import type { ProfileClient } from '../profiles'
import type { Candidate, CandidateRange } from './candidate'
import type { SuggestionProvider } from './providers'
import { commandWord } from './providers'

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

export function hostProvider(opts: { profileClient: ProfileClient }): SuggestionProvider {
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
      // One assembly, one fetch: profiles and aliases are read together so
      // the dedup (an alias covered by a saved profile is suppressed) sees
      // the same snapshot both halves were built from.
      const [profileList, aliasesResponse] = await Promise.all([
        opts.profileClient.listProfiles(),
        opts.profileClient.listSSHAliases(),
      ])
      if (signal.aborted) return { candidates: [] }

      const profiles = profileRows(profileList)
      const { aliases, degraded } = aliasRows({
        profiles: profileList,
        aliases: aliasesResponse.aliases,
        unavailable: aliasesResponse.unavailable,
      })

      const candidates: Candidate[] = []
      for (const item of [...profiles, ...aliases]) {
        const matchRanges = hostMatchRanges(item.label, ctx.token.text)
        if (matchRanges === null) continue
        candidates.push({
          // The row's own id (a profile id, or `__ssh_alias:<alias>`) is
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
      // The degraded condition is data, not a row: it is surfaced as the
      // empty reason when nothing else answered, and never offered as a
      // candidate (profiles still answer on their own).
      if (candidates.length > 0 || degraded === null) return { candidates }
      return {
        candidates: [],
        emptyReason: {
          kind: 'hosts-unavailable',
          reason: degraded.reason,
          detail: degraded.detail,
        },
      }
    },
  }
}
