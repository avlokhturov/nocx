# W9 — the SFTP provider: the half the feature exists for

## Where you are

Your OWN git worktree. **Run `pwd` first.** Never write to
`/home/dev/orca/workspaces/nocx/feat-file-manager-2`.

The issue tracker is NOT in your worktree; `bd` finds nothing. Everything is here.

## Why this one matters more than its size suggests

The design argues the whole feature from one sentence: when an agent occupies the terminal, the
terminal cannot be used to look at files. That argument only holds if the panel follows the user
onto the remote host, because that is where the agent frequently runs. So §4 says it plainly —
**the epic does not close until SFTP lands.** A local-only file tree is the version of this
feature that is dead exactly where it differentiates.

## Read these, in this order

1. **`internal/filesystem/local/local.go`** — your sibling. It is committed, reviewed and
   correct after ten fixes. **Read it before writing anything**: the bounded read, the two
   directory caps, the openability enforcement, the canonical-then-list order and the `Rev`
   digest are all solved there, and your job is the same contract over a different transport,
   not a second interpretation of it.
2. **`internal/filesystem/filesystem.go`** — the `Provider` interface and the types.
3. **`internal/ssh/ssh_fsconn.go`** — committed. `RealClient.FSConn` gives you an SFTP subsystem
   on its own pooled reference, with close-to-cancel and a bounded operation lane already built
   and proven against a never-replying server. **You consume this; you do not reimplement it.**
4. `.internal/specs/2026-08-06-file-manager-design.md` §5.1 in full, plus D2, D3, D9, D14.

## What you own

- `internal/filesystem/sftp/**` — a new package.
- Its tests.

Nothing else. Do not touch `internal/filesystem/*.go`, `internal/filesystem/local/**`,
`internal/ssh/**`, `internal/transport/**`. If the `Provider` interface does not fit, **escalate**
— it is shared with a provider that already satisfies it, so a change there is a real finding.

## Build it

The same `Provider` contract, over SFTP. The differences from `local` are few and each is
specific:

### Paths are POSIX, always

`sftp` uses `path`, never `path/filepath`. The SFTP protocol specifies POSIX-style paths
regardless of the OS nocx runs on. On macOS, `filepath` would treat a remote `C:\Users\me` as
relative and backslashes as ordinary characters. **`path/filepath` must not appear in this
package.**

### Root comes from the provider, and not from a shell

`Root()` uses SFTP canonicalisation — `RealPath(".")` — and not `echo $HOME` over exec. Two
reasons, and the second is the one that bites: remote **commands** may be forbidden on a host
where SFTP is allowed, and shell output is not a path protocol.

Do not reach for `internal/shellintegration/install_remote.go`, which discovers home by remote
exec. It solves a different problem and is the wrong primitive for a filesystem browser.

### Cancellation is split, and it is measured rather than assumed

Of the 39 `*Client` methods in the pinned `github.com/pkg/sftp v1.13.11`, **exactly one public
method takes a context**: `ReadDirContext` (`client.go:379`). Verify that yourself — the previous
design's error was believing a claim of this shape without checking.

- **Listing uses `ReadDirContext`.** The D14 elapsed-time cap is enforced through it, natively.
- Everything else — `Stat`, `Lstat`, `RealPath`, `Open`, `File.Read` — takes no context, and
  `ssh.FSConn` already provides close-to-cancel and the operation lane for those. Use them.

### The caps are not optional and the enumeration is the whole directory

`Total`, the directories-first ordering and the whole-directory `Rev` all require enumerating the
complete directory before any page can be returned. That is inherent, not a choice: remote work
is proportional to directory size, not to rows displayed. So both D14 caps apply, with the same
distinct outcomes `local` produces — `ErrTooLarge{ObservedCount, Limit}` and
`ErrTimedOut{Timeout}` — plus the response-size ceiling. Partial results are **discarded**, never
returned as if complete.

### Reading is bounded and streamed

`min(requested, 2 MiB)`, read at most `limit+1` bytes, **never the whole file** — the guard must
hold for a 40 GB remote file, and over a network the cost of getting this wrong is worse than it
is locally. `Truncated` iff the extra byte was readable. Sample size and mtime before and after
and set `Changed`.

### `Canonical` before listing, and `Rev` includes the link fields

`Listing.Canonical` on every successful list, resolved **before** the listing so the identity and
the entries come from one operation. `Rev` covers name, size, mtime, mode, kind, **`LinkTarget`
and `LinkKind`** — a symlink retargeted to another file of the same size and kind must change the
digest.

### `Watch`

Return the same typed "watch unavailable" error `local` returns today. SFTP has **no**
change-notification in the protocol at all, and the polling that substitutes for it belongs to
the watching wave, not here. Do not build a poller in this package and do not return a channel
that never fires — a silent non-degrade is what the design forbids.

## Tests

The `local` package's suite is your specification for coverage; match it, over SFTP.

- **Every external call has a test where it fails**, and the paired test that the ordinary case
  succeeds. A package here once had tests for every failure path and none asserting it worked on
  a normal machine — where it never had.
- A never-replying server (the fixture in `internal/ssh/ssh_fsconn_test.go` shows the shape).
- Permission denied; ENOENT; a directory past the entry cap; an enumeration past the time cap; a
  file over 2 MiB; a binary; invalid UTF-8; a symlink to a regular file; a broken symlink; a
  symlink retargeted between the list and the read.
- **Interval invariants with both ends named.** Not "Close releases the lease" but "from
  construction until Close returns, the pooled reference is held; after Close returns it is
  released and no goroutine from this provider is running."

Build the SFTP test double the way `ssh_fsconn_test.go` does — in your own package, beside your
tests. Do not add a dependency for it.

## Verify — all four, and the last one is not optional

```
go build ./internal/filesystem/...
go vet ./internal/filesystem/...
go test -race ./internal/filesystem/sftp/
golangci-lint run ./internal/filesystem/sftp/...
```

The linter is scoped to your package: not a repo-wide gate, not slow, and two earlier workers on
this epic left ~30 `errcheck`/`gosec`/`shadow` findings for the coordinator because an earlier
brief failed to list it. Match the repo's existing suppression conventions — `_ = x.Close()`,
`//nolint:errcheck` over a test block — both already in the tree.

Do **not** run `go test ./...`: `internal/shellintegration` has nine pre-existing failures on this
host because `dash` and `zsh` are absent and its tests deliberately fail rather than skip.

## Ground rules

- **No commit, no push, no branch.** Leave the work uncommitted.
- **Do not touch the issue tracker.**
- **No new dependencies.** `github.com/pkg/sftp` is already direct.
- Report **numbers**: test count, `-race` result, exact linter result, and every place where
  `local`'s answer did not transfer and you had to decide. That last list is the most useful
  thing you can send me.

## Lifecycle

`heartbeat` with `--phase` per phase (root/canonical, list + caps, read, tests). One
`worker_done`, `--outcome succeeded` or `--outcome failed`.
