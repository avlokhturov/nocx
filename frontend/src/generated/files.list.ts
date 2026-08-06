/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/files.list.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Result of the files.list JSON-RPC method — one page of one directory, or one of two refusals. A listing is a snapshot: when Rev changes the directory is re-listed in one call and every displayed row is replaced atomically; the frontend never re-sorts (ordering is backend-owned and deterministic before pagination: directories first, then files, each by UTF-8 byte order of the name). The namespace is files. and not fs. because every method here is remote-capable, while fs.complete is declared local-only — a remote-capable fs.list beside it is a misread waiting to happen, and the misread is 'the panel showed the wrong machine's files'. The three states are discriminated by state, never by which fields happen to be present: exactly one branch matches.
 */
export type FilesListResult =
  | {
      /**
       * The outcome discriminator — the renderer switches on this before touching any other field. 'ok' is a real listing.
       */
      state: 'ok'
      /**
       * The directory listed, as the caller asked for it (lexical, provider syntax).
       */
      path: string
      /**
       * The provider-canonical identity of the listed directory, returned from every successful list — not only for symlinks — so the root and every ordinary ancestor speak the same identity vocabulary. This is what the frontend uses to detect symlink cycles (D9): a directory whose canonical appears among its own expanded ancestors is cyclic and must not be expanded.
       */
      canonical: string
      /**
       * The page of entries (offset..offset+limit under the backend's ordering). Never null: an empty directory is [] — a schema that permits null here re-admits a defect this repo has already shipped once (providers marshalling as null).
       */
      entries: FilesListEntry[]
      /**
       * The page's starting offset, as requested. When Rev changes, the refresh form is offset 0 with limit = the count currently displayed — every displayed row is replaced atomically.
       */
      offset: number
      /**
       * The complete directory's entry count. It requires the provider to enumerate the whole directory, which it does for every listing — the ordering, the digest and this count all need it.
       */
      total: number
      /**
       * True when offset + len(entries) < total — the next page exists. The frontend renders 'show next N' from this, never by guessing.
       */
      hasMore: boolean
      /**
       * A cheap digest of the listing — each entry's name, size, mtime, mode, kind, linkTarget and linkKind. When it changes, the directory is re-listed in ONE call and the display replaced atomically; re-fetching page 1, then page 2, then page 3 and calling them one generation would be a lie, because the directory can change between them.
       */
      rev: string
    }
  | {
      /**
       * The outcome discriminator. 'tooLarge' is a refusal, not a listing: the directory has more entries than nocx displays, and no pagination is offered for it.
       */
      state: 'tooLarge'
      /**
       * The directory's entry count, present only when a complete enumeration was actually paid for — otherwise the backend says 'more than N' rather than inventing a total, and this key is absent (a null is never sent for it; an omitted key and a 0 are different and 0 is impossible here, since tooLarge means the count exceeds the cap). Polling is disabled for this directory specifically: a capped directory would otherwise re-enumerate on every tick to compute a digest it will refuse anyway. Manual retry stays.
       */
      observedCount?: number
      /**
       * The entry-count cap that was exceeded — the product limit, the one a user can reason about: 'this directory has more than N entries; nocx does not display directories this large'.
       */
      limit: number
    }
  | {
      /**
       * The outcome discriminator. 'timedOut' is a refusal: the enumeration exceeded the elapsed-time cap and was abandoned.
       */
      state: 'timedOut'
      /**
       * The elapsed-time cap that was exceeded, in milliseconds. Deliberately not the user-facing explanation: the same directory would pass on one network and fail on another. Partial results are discarded, never rendered — an apparently complete prefix of a directory is worse than an honest refusal.
       */
      timeout: number
    }

export interface FilesListEntry {
  /**
   * The entry name — the last path segment, what the tree row shows.
   */
  name: string
  /**
   * The entry's absolute provider path — lexical, the address handed back to files.read or files.open. Distinct from canonical: the identity, which may resolve through symlinks.
   */
  path: string
  /**
   * What the row is — a closed set, and the key of the open/expand table: regular opens, dir expands, symlink follows LinkKind, other (FIFO, device, procfs pseudo-file) does neither — a FIFO blocks forever on read. The backend enforces the table from metadata it reads at the time of the call, never from this field: a UI-supplied kind is a claim about the past. 'unreadable' is not a kind of object but a kind of failure: readdir saw the entry and its metadata could not be read — permission denied, or I/O. It exists so a listing never fabricates plausible empty metadata, and so it stays distinguishable from a genuinely broken symlink, which is a symlink whose target is missing.
   */
  kind: 'regular' | 'dir' | 'symlink' | 'other' | 'unreadable'
  /**
   * The symlink's target as the provider read it. Present only when kind is 'symlink' — a plain string with omitempty semantics, never null — and present even for a broken link, since the target string is what makes 'broken' knowable. Not a guard: a symlink can be retargeted between the list and the open.
   */
  linkTarget?: string
  /**
   * What the symlink resolves to — regular, dir, symlink (a chain) or other when broken. Present only when kind is 'symlink' (omitempty, never null). The UI's expand decision uses it (dir expands, unless cyclic); the backend re-checks from fresh metadata at read time. 'unreadable' is not a kind of object but a kind of failure: readdir saw the entry and its metadata could not be read — permission denied, or I/O. It exists so a listing never fabricates plausible empty metadata, and so it stays distinguishable from a genuinely broken symlink, which is a symlink whose target is missing.
   */
  linkKind?: 'regular' | 'dir' | 'symlink' | 'other' | 'unreadable'
  /**
   * Size in bytes as stat reported it. A directory's size is its own directory-entry size, not a count of children.
   */
  size: number
  /**
   * Last modification time, ISO-8601 UTC.
   */
  modTime: string
  /**
   * The entry's permission bits (the low bits of st_mode). The renderer may show a permissions column; nothing else in this schema depends on them.
   */
  mode: number
}
