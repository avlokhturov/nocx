---
title: File manager — a session-aware file tree and a read-only viewer
status: draft
created: 2026-08-06
supersedes: .internal/specs/2026-08-01-file-manager-design.md (branch shady2k/feat-file-manager)
bead: nocx-708q (rescoped), brainstorm nocx-gglz
---

# File manager — design

## 0. The one rule

**The panel shows files of the machine you are currently in, and never of another one.**

Everything below follows from that sentence: why a filesystem is addressed by a binding the
backend issued rather than by anything the client can name, why a reconnect may not silently
refresh a viewer, and why a local file's tab title is deliberately plainer than a remote
one's.

The rule exists because the panel's actions are consequential. A tree that opens a file and
copies a path is not decoration — if it lists the local `~/orca/workspaces/…` beside a shell
on `srv-01`, it shows one machine's files while the user acts on another's. Being merely
_less useful_ on SSH would be a scheduling question; being _wrong_ on SSH is a design
question.

## 1. What this is

A **Files** view in the existing left activity bar, rendering the filesystem tree of the
**active tab's machine**: local for a local shell, remote over SFTP for an SSH session.

- **Primary action:** open a file in its own tab, read-only.
- **Secondary actions:** copy the path (relative and absolute); show in the OS file manager,
  local tabs only.

### Why a tree in a terminal at all

`docs/vision.md` does not list a file explorer, so the argument has to be made rather than
assumed. It is this: **when an agent TUI occupies the terminal, the terminal cannot be used
to look at files.** `bat`, `less` and `nvim` all need a free prompt. The nocx user runs an
agent in the tab and wants to see what it just wrote — the one moment the normal tools are
unavailable. The panel is file access while the terminal is busy.

That argument only holds if the panel follows the user onto the remote host, because that is
where the agent frequently runs. **SFTP is therefore inside this epic, not after it.**

## 2. What changed since the 2026-08-01 draft, and why

The superseded draft was reviewed adversarially once and was still wrong in five load-bearing
places. Four were found by a second review against the code on 2026-08-06; the fifth is a
scope decision by the owner. Each is recorded here because each one, uncaught, would have
been discovered during implementation at the worst possible time.

| Was                                                                      | Is                                                                          | Verified at                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| "This epic delivers the multi-view sidebar mechanism plus one view"      | The mechanism shipped with Ports. Files is one more `SidebarViewDescriptor` | `frontend/src/main.tsx:295`, `frontend/src/sidebar.tsx:50` |
| Root comes from the session's cwd                                        | On SSH that cwd can be the **local** home. Root comes from the provider     | `internal/session/session.go:271`                          |
| Every call carries `sessionId`; a viewer restores by `{origin, path}`    | Calls carry a backend-issued binding. `sessionId` is minted fresh per Open  | `internal/session/session.go:172`                          |
| SFTP needs a new pool-lease seam, and cancellation is goroutine+deadline | Both already exist as `DiscoveryConn`; we extend that answer                | `internal/ssh/ssh_discovery.go:13`, `:378`                 |
| Refresh on OSC 133 command-end                                           | Refresh comes from the filesystem — an agent is one long command            | `frontend/src/agent-status.ts:3`                           |

The fourth row is the one worth reading twice. The draft proposed running each uncancellable
`pkg/sftp` call on its own goroutine, returning on `ctx.Done()`, and letting the goroutine
"drain under a hard deadline". That has an impossible branch: **when the deadline expires,
nothing makes the blocked goroutine return.** The deadline was a word, not a mechanism.
`DiscoveryConn` already solves exactly this, and says so in its own doc comment: it cancels a
non-context-aware remote operation _by closing the session_, then **waits**, "so no goroutine
outlives the call". We extend that rather than write a second, worse answer — AGENTS.md,
"look for the existing answer before you write a second one".

## 3. Decisions

| #   | Decision                                                                                                                                                                                                  | Rejected alternative, and why                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **A filesystem is addressed by a `bindingId` the backend issues** from a `sessionId`. Only `files.open` takes a `sessionId`                                                                               | Every call taking `sessionId`. It makes the wrong pairing inexpressible (good) but ties every read to shell lifetime (fatal): `sessionId` is re-minted on every Open, so nothing survives a restart         |
| D2  | **The provider computes the root**; a verified OSC 7 cwd overrides it when present. An inferred root is labelled                                                                                          | The session's `Cwd()`. For an SSH session with no explicit cwd it is the **local** `os.UserHomeDir()`. AD-5 already requires a `$HOME` fallback to be "surfaced to the user, not applied silently"          |
| D3  | **The SFTP lease is a sibling of `DiscoveryConn`**: its own pooled reference, cancellation by closing the subsystem, `Close` waits for in-flight calls                                                    | A goroutine-per-call with a drain deadline. Unbounded stuck calls, and a deadline that unblocks nothing                                                                                                     |
| D4  | **Two identities, two authorities.** A client `RequestToken {tabId, generation}` is echoed and never authorises; a backend `Binding {bindingId, endpointId}` authorises and is never minted by the client | One `Origin` struct carrying both. `tabId` is a frontend integer the backend cannot attest; mixing them invites authorising on a client-supplied value                                                      |
| D5  | **Refresh comes from the filesystem**: fsnotify locally, polling over SFTP, both behind one provider-side watch capability                                                                                | OSC 133 command-end (blind inside a long-running agent) and agent-activity heuristics (a file can be changed by anyone — cron, another session, another person)                                             |
| D6  | **No automatic rebind after reconnect.** A stale viewer offers **Reload**, enabled only when a live session's `endpointId` matches                                                                        | Silent rebind on endpoint match. Same identity check, but it moves content under a reader who did not ask. Rebinding by profile id — which the draft did — is worse still: a profile is editable            |
| D7  | **The viewer is a snapshot plus an offer.** A file that changed is announced, never silently reloaded                                                                                                     | Live-following content. A log you are reading scrolls out from under you                                                                                                                                    |
| D8  | **Root is navigation scope, not a sandbox.** No `..` row; a symlink may leave the root and is rendered plainly                                                                                            | Enforcing containment. It would be security theatre: the real boundary is the account's own permissions, and pretending otherwise invites someone to rely on it                                             |
| D9  | **Directory symlinks expand; cycles are detected by canonical ancestry** and rendered as a non-expandable leaf                                                                                            | Refusing to expand directory symlinks. Common in real trees (`node_modules`, `/usr/local`); refusing hides half the filesystem to avoid ten lines of cycle check                                            |
| D10 | **No row virtualisation.** A page of N children per directory plus an explicit "show next N"                                                                                                              | Virtualised rows — what Orca needed (`@tanstack/react-virtual`). Deferred to `nocx-goi0`. A cap without pagination is worse than either                                                                     |
| D11 | **New methods live under `files.*`, not `fs.*`**                                                                                                                                                          | Extending `fs.*`. `contracts/fs.complete.schema.json` declares that namespace **local-only** ("the provider is inactive on a remote session"). A remote-capable `fs.list` beside it invites a fatal misread |
| D12 | **One live viewer per `{endpointId, canonical path}`** via the existing `singletonKey`                                                                                                                    | A tab per click. `tabs.ts:543` already deduplicates                                                                                                                                                         |
| D13 | **File bytes never reach disk.** A viewer restores as its identity and re-reads on demand                                                                                                                 | Persisting the bytes — up to 2 MiB of possibly-secret remote content in unencrypted config storage                                                                                                          |

### D11 in full: why a second directory lister is justified

`internal/completion` already lists remote directories, through `SSHCompleter` running bash
over a `DiscoveryConn`. Under the AGENTS.md rule this must be justified rather than
duplicated silently.

They answer different questions. Completion asks _"what does the shell think completes this
prefix"_ — a question only a shell can answer, because it includes bash's own completion
rules. The tree asks _"what does this directory contain, with sizes, modes and mtimes"_ — a
filesystem question, and SFTP answers it structurally, works when remote **exec** is
forbidden while SFTP is allowed, and does not spend a shell. Parsing `ls` output for the tree
would be the second implementation, not this one.

**This reasoning goes in the code**, at `internal/filesystem`'s package doc, not only here.

## 4. Scope

### In

- Files view in the existing activity bar, ordered before Ports.
- Per-tab root from D2; lazy expansion with pagination; collapse.
- Automatic refresh (§5.5) with a visible mode indicator and a manual refresh action.
- Open a **regular file** in its own tab, read-only, with syntax highlighting.
- Copy path — relative to root, and absolute.
- Show in the OS file manager — **local tabs only; absent, not disabled, on a remote tab.**
- Both providers: local **and** SFTP. **The epic does not close until SFTP lands.**
- Lifecycle: session close, connection loss, app restart (§5.6).

### Out — each a refusal, not an omission

- **All mutation**: create, rename, delete, move, duplicate, drag-and-drop. The next epic.
- **Editing.** The viewer is read-only. The next epic.
- **Upload / download / drag-drop transfer.** Stays in `nocx-9le.5`.
- **Insert path at the prompt, and shell-escaped copy.** Both need the originating terminal
  as an explicit target and a shell-dialect quoting decision; own bead.
- **Name filter and content search** (`nocx-bkmy`). A filter over lazily-loaded nodes
  silently fails to find files that exist — worse than no control.
- **Git status markers** (`nocx-terg`). No git surface exists in the backend.
- **Row virtualisation** (`nocx-goi0`).
- **Multi-selection.**
- **A dotfile toggle.** Dotfiles are shown, as in both reference products.

## 5. Architecture

### 5.1 Backend — `internal/filesystem`

```go
type Provider interface {
    Root(ctx context.Context) (Root, error)
    List(ctx context.Context, path string, page Page) (Listing, error)
    Read(ctx context.Context, path string, maxBytes int64) (Content, error)
    Watch(ctx context.Context, path string) (Watch, error)
    Canonical(ctx context.Context, path string) (string, error)
    Close() error
}

type Root    struct { Path, Display string; Inferred bool; InferredReason string }
type Page    struct { Offset, Limit int }
type Entry   struct {
    Name, Path string
    Kind       Kind   // regular | dir | symlink | other
    LinkTarget string // symlinks only
    LinkKind   Kind   // what the link resolves to; `other` when broken
    Cycle      bool   // canonical path equals an ancestor's (D9)
    Size       int64
    ModTime    time.Time
    Mode       uint32
}
type Listing struct { Path string; Entries []Entry; Offset, Total int; HasMore bool; Rev string }
type Content struct {
    Path      string
    Text      string // always valid UTF-8
    Size      int64
    ModTime   time.Time
    Truncated bool
    Binary    bool
    Lossy     bool
    Changed   bool // size or mtime differed before vs after the read
}
type Watch interface { Events() <-chan struct{}; Mode() WatchMode; Close() error }
```

The interface has **no mutating method**, so mutation cannot be added to one provider without
changing the contract for both. It is a rule about symmetry, not a permanent ban: the next
epic adds mutating methods, and adds them to both.

**`Kind` replaces the draft's `IsDir`/`IsSymlink` pair** because the two encode a lattice the
product must not flatten: only `regular` may be opened. A FIFO blocks forever on read; a
device or a procfs pseudo-file has no meaningful size and may produce unbounded or
ever-changing content. Refusing them is a one-line check that removes a class of hang.

**Ordering is backend-owned and deterministic before pagination**: directories first, then
files, each by the UTF-8 byte order of the name, case-sensitive. The frontend never re-sorts
— a `localeCompare` in the renderer would disagree with the server's paging boundaries and
make "show next N" duplicate and skip rows. `Listing.Entries` is always non-nil: an empty
directory marshals as `[]`, never `null`.

**`Rev` is a cheap digest** of the listing (each entry's name, size, mtime, mode, kind). It
is what the SFTP watcher compares, and what makes pagination safe: **when `Rev` changes, the
loaded pages of that directory are re-listed from offset 0** up to the count already shown,
under one new generation. Offset pagination over a mutating sorted list otherwise duplicates
and skips silently.

**Path syntax belongs to the provider.** `local` uses `path/filepath`; `sftp` uses `path`,
because SFTP specifies POSIX-style paths regardless of the OS nocx runs on. `filepath` must
not appear in transport or in code shared by both providers.

**Three path kinds, never conflated.** _Display_ (`~`-abbreviated, for the header), _lexical_
(from the root, for "copy relative path"), _canonical_ (provider-canonicalised, the identity
used by `singletonKey` and by the D9 cycle check).

**Reading is bounded and streamed.** `maxBytes <= 0` means the server default; the effective
limit is `min(requested, 2 MiB)` — the parameter can only lower the ceiling. The provider
reads at most `effectiveLimit + 1` bytes and never the whole file, so the memory guard holds
for a 40 GB file; `Truncated` is true iff that extra byte was readable. Size and mtime are
sampled before and after; a difference sets `Changed`, which is how the viewer can say "this
changed while I was reading it" instead of presenting an unknowable mixture.

**`Binary` is a heuristic and is labelled as one**: a NUL among the bytes actually read. A
binary whose first bytes are NUL-free reads as text; accepted. When `Binary`, `Text` is empty
and the viewer says "binary file, N bytes" — never base64.

#### The SFTP lease (D3)

`internal/ssh` gains `RealClient.FSConn(ctx, host, opts…) (ssh.FSConn, error)`, a **sibling of
`DiscoveryConn`** (`ssh_discovery.go:378`) built from the same two ingredients:
`pool.AcquireDial` plus a release func. It differs in what it exposes — an SFTP subsystem
rather than `Exec` — and is identical in the three properties that matter:

- It owns **its own** pooled reference, never the tab's, so closing the terminal cannot drop
  the transport under an in-flight read.
- **Cancellation is closing.** `pkg/sftp` calls are not context-cancellable; the lease closes
  the subsystem to unblock them, then **waits** — no goroutine outlives the call.
- `Done()` closes on connection loss and **not** on `Close()`, so an intentional stop is not
  read as a lost connection.

`internal/filesystem` declares its own narrow consumer interface for it, the way
`internal/discovery/discovery.go:113` does. `ssh.SSH` (`ssh.go:113`) is **not** widened: it
stays `Connect`/`Close`, and a feature that needs a lease depends on a lease interface.

One SFTP client per binding multiplexes all its requests. A **bounded operation lane** caps
concurrent in-flight calls per binding; when a call exceeds the hard timeout the client is
closed and poisoned, its lease released, and the binding reports itself dead. A poisoned
binding is a visible state, not a retry loop.

#### Bindings

```go
type Binding struct {
    ID         string    // backend-issued, opaque
    EndpointID string    // attestation; empty for local
    Provider   Provider
}
```

A `Registry` maps `bindingId → Binding`. `files.open{sessionId}` resolves the session, builds
the provider, takes the lease, and returns the id. Every later call takes the id.

**A binding does not outlive its session.** Closing the terminal closes its bindings: the
lease exists to protect an in-flight read from a concurrent close, not to keep an SSH
connection alive because a file viewer is open somewhere. A viewer whose binding is gone
keeps what it already has on screen and says the source is unavailable (§5.6). The rejected
alternative — a binding that survives its terminal — means closing your SSH tab leaves nocx
connected, which no user would predict.

**Close is a lease, not a lookup.** `Reg.Get` returns a session pointer that `Reg.Close` can
invalidate immediately (`session.go:240`); a handler that resolved a binding and then called
it can hit a closing provider. Handlers hold a lease for the call's duration; close waits for
outstanding leases, bounded by the operation lane's timeout. Testing only "unknown binding
id" does not cover this — the race is between lookup and use.

#### `endpointId` (D4, D6)

The backend's attestation of what the transport actually reached, not of what was intended.
A **versioned** canonical encoding, hashed:

```
v1 ‖ resolved host ‖ port ‖ effective principal ‖ full resolved jump route ‖ host-key fingerprint per hop
```

The version prefix is load-bearing: changing the definition later must **fail** to match old
restored viewers rather than accidentally matching them.

Neither existing key is this. `ssh.IdentityKey` (`ssh_resolver.go:272`) is the resolved
`user@host:port` from the `ssh -G` answer — intent, and it omits the jump route and the host
key. The pool key (`ssh_dial.go:43`) additionally separates the credential principal, which
is closer, but it is an authorisation boundary for connection sharing, not a statement about
the far end. Reusing either would be borrowing a value for a purpose it was not defined for —
and both are documented as authorisation-boundary keys, so quietly widening them here would
widen that boundary too.

### 5.2 Wire — control plane, JSON-RPC (AD-1)

| Method         | Params                             | Result                                                                 |
| -------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `files.open`   | `{sessionId}`                      | `{bindingId, endpointId, root:{path,display,inferred,inferredReason}}` |
| `files.list`   | `{bindingId, path, offset, limit}` | `{path, entries[], offset, total, hasMore, rev}`                       |
| `files.read`   | `{bindingId, path, maxBytes}`      | `{path, text, size, modTime, truncated, binary, lossy, changed}`       |
| `files.watch`  | `{bindingId, paths[]}`             | `{mode, degradedReason}` — replaces the watch set for this binding     |
| `files.close`  | `{bindingId}`                      | `{}`                                                                   |
| `files.reveal` | `{bindingId, path}`                | `{}` — local bindings only; errors on a remote one                     |

A change is announced by a **server-initiated notification**. Two existing mechanisms supply
the two halves, and they must not be confused: `broadcastSettingsChanged` (`ws.go:2888`) is
the precedent for the **shape** — a `jsonrpc` frame with `method` and `params` and no `id` —
but it writes to every connection, which is the wrong addressing here. The precedent for
addressing **one** connection is `sessionRx.subscriber` (`ws.go:43`), which already binds a
session's output to a single `*wsConn`; and every control handler already receives its
`wconn *wsConn` (e.g. `handleOpen`, `ws.go:1049`), so the connection that opened a binding is
in scope when the binding is created.

```
<-- {"jsonrpc":"2.0","method":"files.changed","params":{"bindingId":"…","path":"…","rev":"…"}}
```

It is addressed to the **one connection that owns the binding**, not broadcast: a binding
belongs to a session, and a second client has no business learning that a directory on
somebody else's SSH connection changed. `rev` lets the client skip a re-list it has already
applied. The notification carries **no entries** — it is an invalidation, and the client
re-lists through `files.list`, so there is exactly one code path that renders a directory.

`files.watch` **replaces** the watch set rather than adding to it, so collapsing a directory
cannot leak a watch: the client sends the set it currently wants, and the backend diffs.

**`sessionId` appears exactly once**, on `files.open`. That is what keeps the wrong pairing
inexpressible: there is no parameter by which a caller can ask for the local filesystem of an
SSH session, and no way to name a filesystem the backend did not hand out.

`files.reveal` **errors** on a remote binding rather than silently doing nothing. The UI does
not offer it there at all; the backend refuses anyway, because a UI-only guard is one bug
away from being no guard.

Guards, each with a test: the 2 MiB ceiling and the streamed read; only `regular` is
readable; paths are absolute and cleaned by the **provider's** rules; permission denied is an
explicit node state, never a silently empty directory; a dead SFTP channel is a rendered
error.

### 5.3 Contracts

Every method above gets a JSON Schema in `contracts/` **in the same commit** (`nocx-bt3w`),
with `additionalProperties: false` and explicit `required`, and three checks each:

1. `npm run contracts:check` — the committed generated types match the schema.
2. `…_DTOConformsToContract` — the Go struct marshals to something the schema accepts.
3. `…_OverTheWireConformsToContract` — the real result off the real socket. This is the one
   that catches a field the server never sends.

The renderer's types are generated and re-exported; the client declares nothing of its own.

### 5.4 Frontend

**Files is one more sidebar view.** `frontend/src/main.tsx:295` already registers Ports as
"the first real one" and names Explorer as future work; `sidebar.tsx:50` already defines
`SidebarViewDescriptor {id,title,icon,view,actions,order}` and gives every view a reactive
`visible()`. Files registers with a lower `order` than Ports. **Nothing about the shell is
rebuilt or forked.**

**`SidebarViewProps` needs a second accessor.** It exposes only `activeProfileId()`, which
was designed for Ports and is not enough here: an alias tab has no profile, a profile is
editable, and local is the synthetic string `"local"` (`ports-client.ts:11`). Files needs
`activeOrigin(): {tabId, sessionId, kind, cwd, cwdVerified} | null`. This is an addition to
the shared props, not a private copy inside the view — a private copy is exactly the pattern
`nocx-ycet` exists to end.

**Two identities, two authorities (D4).**

```ts
interface RequestToken {
  readonly tabId: number
  readonly generation: number
} // client, echoed
interface Binding {
  readonly bindingId: string
  readonly endpointId: string | null
} // backend
```

A response is applied only when its `RequestToken` matches the view's current one **and** its
generation is not older than what has already been applied. That is what stops a
`files.list` for tab A, still in flight when the user activates tab B, from painting A's
remote listing into B's tree. Rows carry a compact node reference plus the binding — not a
full copy of both identities per row, which was the draft's over-engineering.

**The backend never authorises on `tabId`.** It is a correlation token and nothing else.

**Panel focus.** The panel follows the active tab's origin. A viewer tab has no terminal
session, so it carries the binding it was opened from and the panel keeps showing that
machine — **never a silent fall back to local**, which would breach §0 in the same gesture as
the panel's own primary action.

**Kit only.** `Toolbar`, `IconButton`, `EmptyState`, `Spinner` come from `ui/`. Neither
reference product had an off-the-shelf tree to copy — Orca hand-writes ~41 files over
`@tanstack/react-virtual` and `@dnd-kit`, termic hand-writes `FileTree.tsx` over Radix, and
both are React. Kobalte, the Solid equivalent, was measured and rejected
(`2026-07-27-kobalte-spike-report.md`: ~34 KB gzip of shared core against a 25–35 KB total
budget) and has no tree primitive regardless. So **`ui/tree-row.tsx` is a new kit component**
— one module, one CSS file in `styles/components/`, a stable identity class, a test, a row in
the kit README. It is not built inside the surface. Where `CollectionView`'s row variance
already fits, it is extended rather than forked.

**Viewer tab.** A `ContentDescriptor` with `singletonKey = "${endpointId ?? 'local'}:${canonicalPath}"`
(D12) and a `restoreDescriptor` of the new `{type:'file', endpointId, path, displayHost}` —
consistent with the tab-restore ownership rule in `architecture.md:196`, where the record is
backend-owned identity plus a frontend snapshot. Content is CodeMirror 6 in read-only mode:
already a dependency, and it brings line numbers, selection and search for free. Syntax
highlighting needs `@codemirror/language` plus language modes — a **small registry** of the
formats that actually turn up in terminal work, with plain text as the correct fallback, not
one package per language that exists.

**Titles carry provenance asymmetrically.** A remote file is `srv-01 · nginx.conf` plus the
profile colour badge (`nocx-9le.4`); a local file is the basename alone. **Absence of a host
marker is what means "this machine"**, so the marker must never be spent on the local case.

### 5.5 Refresh (D5)

Watching is a provider capability. The panel is told "this directory changed" and never
learns which mechanism said so.

**Local — fsnotify** (new dependency), one non-recursive watch per **expanded** directory.

- Events are **invalidation hints, never the diff**: coalesce, then re-list the directory and
  compare `Rev`. An editor's write-temp-then-rename produces a burst that means one change.
- Watches are re-established when a watched directory is renamed, deleted, recreated, or the
  backend reports overflow.
- There is a ceiling on watched directories and on outstanding re-lists. Expanding a large
  dependency tree must not exhaust inotify watches or descriptors.

**Remote — polling.** SFTP has no change notification, and this asymmetry is honest rather
than a gap to be closed cleverly. Poll the **displayed pages of expanded directories only**,
compare `Rev`, emit only on difference. Jittered interval, per-host concurrency limit,
exponential slow-down on repeated failure, paused while `visible()` is false, and one
immediate poll when the panel becomes visible again.

**Degradation is a state, not a toast.** When a local watch cannot be established, the
provider falls back to polling and reports `mode: 'polling', degradedReason` — and the panel
header **shows** that it is polling for as long as it is true. A toast announces the
transition; it cannot answer "why is this stale?" ten minutes later. A soft degrade the UI
does not admit is how a feature that does not work survives a release.

**Rejected, and why they stay rejected.** A shell hook emitting changes would observe only
what passes through that shell — not the agent, not cron, not another session, not another
person — while the product claims automatic refresh; a partial observer sold as a complete
one is worse than polling. `inotifywait`/`fswatch` assume software on the host. The Tier-B
remote helper is the architecturally sanctioned path — `architecture.md:203` names "richer
remote metadata (file-tree)" as its revisit trigger and reserves the `metadata` msg-type for
its feed — and it is a **later** epic (`nocx-if6`), consent-gated, that must augment polling
and degrade back to it. Bending the current shell-integration scripts into a provisional
relay is the trap.

### 5.6 Lifecycle

Four different things get called "disconnected", and only two are ours.

| State                             | Panel                              | Open viewer tabs                                                                     |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| WebSocket drop (frontend↔backend) | Unchanged — AD-9 replays by offset | Unchanged                                                                            |
| SSH connection lost               | "Connection lost" banner; no poll  | Content stays; **Reload** disabled                                                   |
| Originating terminal closed       | Follows the next active tab        | Content stays; "source unavailable"; **Reload** disabled                             |
| Reconnected, `endpointId` matches | Rebinds; refresh resumes           | **Reload** enabled — user-invoked, never automatic (D6)                              |
| Reconnected, `endpointId` differs | Rebinds to the new machine         | Stays stale; "reconnected to a different host or user"; **Reload** stays disabled    |
| App restarted                     | Builds from the restored tab       | Restores identity, no bytes (D13); **Reload** enabled once a matching session exists |

D6 is the load-bearing line. A profile can be edited between the drop and the reconnect —
host, user, port, jump route. Rebinding on profile id would refresh a viewer labelled
`root@srv-01 · /etc/nginx.conf` from `deploy@srv-02` while keeping the label. Matching on the
backend's attestation, and only on an explicit Reload, is what makes that impossible.

**SSH reconnect itself is not this feature's to build.** It belongs to `nocx-9le`, does not
exist yet, and this design **consumes** it. The panel works without it, just without a way
back. That is a dependency edge, filed, not an assumption.

## 6. Sequence

1. **ADR** recording §3. Required by `nocx-708q` before implementation.
2. `internal/filesystem` + the `local` provider + `files.open/list/read/close` + contracts +
   the binding registry and its close-lease.
3. Files view + tree row in `ui/` + viewer tab + request-token plumbing + dedup.
4. `ssh.FSConn` + the `sftp` provider + `endpointId` + the lifecycle of §5.6.
   **The epic does not close before this.**
5. Watching: local fsnotify, then SFTP polling, then the degraded-mode indicator.
6. Copy path (relative, absolute) and `files.reveal`.

## 7. Testing

**Every external call has a test where it fails.** Permission denied; ENOENT; a directory
larger than one page; a file over 2 MiB; a binary; a NUL at byte 9000; invalid UTF-8; a file
that changes size mid-read; a FIFO; a dead SFTP channel; a server that accepts and never
replies; a session that dies between lookup and use; a symlink cycle; an inotify watch that
cannot be established.

**Falsifying §0** — the scenarios that would have caught the previous drafts:

- Switch A→B while `files.list(A)` is in flight; assert B's tree never shows A's entries.
- Close the originating terminal with a viewer open; assert the viewer reports the source
  unavailable and **never** re-reads through any other binding.
- Reconnect to a **different** endpoint; assert Reload stays disabled and nothing refreshes.
- Restart with a viewer open; assert no file bytes were written to config storage.
- Two out-of-order refresh responses; assert the older is dropped.
- A remote path whose syntax differs from the local OS; assert the provider's rules were used.
- An SSH session opened with no explicit cwd; assert the root came from the **remote** home,
  not from `os.UserHomeDir()`, and that an inferred root says so.
- A directory that gains an entry between page 1 and page 2; assert no row is duplicated or
  skipped.

**"And on a normal machine it succeeds."** For every "returns an error when…" above, the
paired test that the ordinary path works — the `contentkey` lesson.

**One user-reachable end-to-end assertion**, through the seam a person touches:

> From a cold start with the panel collapsed, the Files icon is present and enabled; clicking
> it opens the panel; the tree shows the root; expanding a directory lists a page and "show
> next" reveals the rest; clicking a file opens a tab whose content matches the file; its
> title carries the host iff the origin is remote; writing to the file from outside nocx makes
> the row update without anyone pressing anything.

Headless via `cmd/devharness` plus the `NOCX_WS_PORT` shim — no wails, no GTK, no display.
The e2e suite gets a disposable `$HOME` (`NOCX_E2E_HOME_DIR`).

**Invariants as intervals, both ends named:**

- From the moment a binding is issued until it is closed or its connection is lost, every
  response applied to that tree came from that binding — and never from another machine.
- From the moment a tab opens until the user invokes "set root to current directory", the
  tree's root does not change, whatever the shell's cwd does, including a late OSC 7.
- From the moment a local watch fails until it is re-established or the view is closed, the
  header states that refresh is polling.

**Contracts** — the three checks of §5.3, for all six methods.

**Reachability** — `deadcode -filter 'nocx/internal/filesystem' ./...` is clean and
`internal/app/app.go` wires the providers. Then the other direction: assert a caller for the
watch path specifically. A reachable read path hiding an unreachable write path in the same
package is precisely what `nocx-rtg0` shipped.

## 8. Bead changes

| Bead             | Change                                                                                                                                                                | Reason                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `nocx-708q`      | Rescope to this document. Drop "deliver the multi-view mechanism" — it shipped with Ports. Drop the name filter and git markers. SFTP enters the completion criterion | `main.tsx:295`; otherwise the feature is dead where it differentiates                                          |
| `nocx-708q`      | **Remove** the dependency edge on `nocx-jv3q`                                                                                                                         | Tab groups are not a precondition; provenance rides on the tab                                                 |
| `nocx-jv3q.1/.2` | **No change.** The previous draft legislated their grouping key and removed drag-between-groups; that is reverted                                                     | Not this design's decision to make                                                                             |
| `nocx-9le.5`     | Narrow to upload/download/drag-drop transfer; listing and reading move here                                                                                           | Otherwise two epics build directory listing twice                                                              |
| `nocx-9le.4`     | Link as the provenance carrier for viewer tab badges                                                                                                                  | The colour badge gains a second consumer                                                                       |
| `nocx-goi0`      | Unchanged; still deferred by D10                                                                                                                                      |                                                                                                                |
| `nocx-bkmy`      | Unchanged; still deferred                                                                                                                                             |                                                                                                                |
| `nocx-terg`      | Unchanged; still deferred                                                                                                                                             |                                                                                                                |
| new, epic        | **File manager: mutation** — create, rename, delete, move, duplicate, and editing with conflict detection, both providers                                             | The owner's second slice; needs its own design for atomic write, trash-vs-unlink asymmetry and conflict policy |
| new, `nocx-9le`  | **SSH session reconnect on connection loss**, with an `ask`/`auto`/`never` setting                                                                                    | §5.6 consumes it; no bead covers it                                                                            |
| new              | `ssh.FSConn` — an SFTP-capable sibling of `DiscoveryConn`                                                                                                             | D3                                                                                                             |
| new              | `SidebarViewProps.activeOrigin()`                                                                                                                                     | §5.4; `activeProfileId` cannot express an alias tab                                                            |
| new              | `files.reveal` native seam (Wails)                                                                                                                                    | No such capability exists in the backend                                                                       |
| new              | Insert path at the originating prompt + shell-escaped copy                                                                                                            | §4 Out; needs a dialect decision                                                                               |

## 9. Open questions

None blocking. The page size (D10), the 2 MiB ceiling, the poll interval, the operation-lane
timeout and the watched-directory ceiling are starting numbers, to be tuned once the panel is
in daily use. Each is named in code with the reason it is a number rather than a constant
somebody picked.

## 10. Review history

- **2026-08-01** — first draft; adversarial review against the code found three breaches of
  §0 (a response applied to the wrong tab, an action aimed at the active tab, a reconnect
  rebinding by profile id) and they were fixed.
- **2026-08-06** — a second review against the code found the five items in §2. Three of them
  were things the repository had already solved or already contradicted, and the document had
  neither read nor cited: `DiscoveryConn`, `main.tsx:295`, `resolveSessionCwd`. The pattern is
  worth naming, because it is the same pattern both times: **the draft was written from what
  the conversation remembered rather than from the binding document and the code for the
  boundary being crossed.**
