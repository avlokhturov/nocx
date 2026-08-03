/**
 * The quick-connect host assembly — the single derivation of "which hosts do
 * I know", shared by the picker (quick-connect.tsx) and completion
 * (suggest/host-provider.ts). Plain module: no solid-js, no DOM, importable
 * from a node test.
 *
 * One derivation, two consumers (bead nocx-n9i6): completion routes the
 * picker's assembly read-only instead of rebuilding it, so the two can never
 * drift. This module is that assembly, lifted out of the UI module whose
 * solid-js/web import chain made it DOM-bound. The consumers fetch the raw
 * data themselves (each keeps its own RPC pattern) and turn the rows into
 * their own items — the picker adds the run callback, completion reads
 * label/id directly.
 *
 * The answer is typed rows plus the degraded-resolver condition as data —
 * never a human-facing label that would have to be parsed back out.
 */
import type { SSHAliasEntry, SSHAliasUnavailable, SSHProfile } from './profiles'

/** A saved profile that can be connected to (host filled in), as both
 *  surfaces list it. */
export interface HostProfileRow {
  /** The profile id — the stable identity completion dedups on. */
  readonly id: string
  /** `user@host` when the profile has a user, else `host`. */
  readonly label: string
  /** The profile's display name. */
  readonly detail: string
  /** The address opening the row acts on. */
  readonly host: string
  readonly user?: string
}

/** A live ~/.ssh/config alias after the saved-profile dedup, as both
 *  surfaces list it. */
export interface HostAliasRow {
  /** `__ssh_alias:<alias>` — the stable identity completion dedups on. */
  readonly id: string
  /** `user@alias` when the alias has a user, else `alias`. */
  readonly label: string
  /** The resolved HostName when it differs from the alias. */
  readonly detail?: string
  /** The alias and its overrides — what opening the row acts on. */
  readonly alias: string
  readonly user?: string
  readonly port?: number
}

/** The alias half's answer: the deduped live rows, and why the resolver
 *  could not answer when it could not — typed data, never a label. */
export interface HostAliasAssembly {
  readonly aliases: HostAliasRow[]
  readonly degraded: SSHAliasUnavailable | null
}

/**
 * The saved-profile half of the host list. A profile saved before its host
 * was filled in is not a connection: opening it hands the backend an empty
 * address and the tab comes up on "Terminal failed to start"; it would also
 * render as a row with an empty primary label — a stray indent rather than a
 * line. The palette lists what can be connected to; finishing such a profile
 * is what the New-connection action is for.
 */
export function profileRows(profiles: SSHProfile[]): HostProfileRow[] {
  return profiles
    .filter((p) => p.options.host != null && p.options.host.trim() !== '')
    .map((p) => {
      const user = p.options.user
      const host = p.options.host
      return {
        id: p.id,
        label: user ? `${user}@${host}` : host,
        detail: p.name,
        host,
        user,
      }
    })
}

/**
 * The live half of the host list: ~/.ssh/config aliases, deduped against the
 * saved profiles (an alias already targeted by a saved profile is suppressed
 * — the profile is ours and wins), plus the degraded-resolver condition as
 * typed data. When the resolver could not answer, no aliases are offered and
 * the condition is carried in `degraded` — the surfaces decide how to say so.
 */
export function aliasRows(input: {
  profiles: SSHProfile[]
  aliases: SSHAliasEntry[]
  unavailable: SSHAliasUnavailable | null
}): HostAliasAssembly {
  if (input.unavailable != null) {
    return { aliases: [], degraded: input.unavailable }
  }
  // Get saved profiles for deduplication: an alias already targeted by a
  // saved profile is suppressed (priority is ours).
  const coveredAliases = new Set(
    input.profiles
      .filter((p) => p.options.host != null && p.options.host.trim() !== '')
      .map((p) => p.options.host),
  )
  return {
    aliases: input.aliases
      .filter((a) => !coveredAliases.has(a.alias))
      .map((a) => ({
        id: `__ssh_alias:${a.alias}`,
        label: a.user ? `${a.user}@${a.alias}` : a.alias,
        detail: a.hostName !== a.alias ? a.hostName : undefined,
        alias: a.alias,
        user: a.user,
        port: a.port,
      })),
    degraded: null,
  }
}
