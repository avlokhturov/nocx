# W4 — `ssh.FSConn`: an SFTP-capable sibling of `DiscoveryConn`

## Where you are

You are in your OWN git worktree. **Run `pwd` first and use that path for everything.**
Never write to `/home/dev/orca/workspaces/nocx/feat-file-manager-2` — that is the
coordinator's checkout.

The issue tracker is NOT in your worktree; `bd` will find nothing. Everything is here.

## Read these two, in this order

1. **`internal/ssh/ssh_discovery.go`** — read it in full before writing anything. It is the
   answer you are extending, not a file you are imitating loosely.
2. `.internal/specs/2026-08-06-file-manager-design.md` §5.1, the subsections "The SFTP lease
   (D3)" and "Cancellation: measured, not assumed", plus D3 in §3.

## What you own — and nothing else

- `internal/ssh/ssh_fsconn.go` (name it to match the package's existing convention)
- its test file

**Nothing else.** Do not touch `internal/filesystem` — another worker is writing that package
right now. Do not touch `internal/session`, `internal/transport`, `internal/app`, `internal/ssh/ssh.go`,
`internal/ssh/pool.go`, or any other existing file in `internal/ssh`. If you believe an existing
file must change, **escalate rather than change it** — that is a boundary decision, not an
implementation detail.

In particular: **`ssh.SSH` (`ssh.go:113`) is NOT widened.** It stays `Connect`/`Close`. A
feature that needs a lease depends on a lease interface, the way
`internal/discovery/discovery.go:113` declares its own narrow consumer interface. That is a
decision the design already made and it is not yours to revisit.

## Build it

`RealClient.FSConn(ctx, host, opts...) (ssh.FSConn, error)`, built from the same two ingredients
`RealClient.DiscoveryConn` uses at `ssh_discovery.go:378` — `pool.AcquireDial` plus a release
func. It differs from `DiscoveryConn` in exactly one thing: what it exposes. `DiscoveryConn`
gives you `Exec`; `FSConn` gives you an **SFTP subsystem**.

The three properties that must be identical, because each was bought by a specific failure:

1. **It owns its OWN pooled reference, never the tab's.** Closing the user's terminal must not
   drop the transport underneath an in-flight read.
2. **Cancellation is closing, and closing waits.** `DiscoveryConn` says it in its own doc
   comment: context cancellation alone does not make a non-context-aware call cancellable, so it
   closes the session and then **waits for the call to return, so no goroutine outlives the
   call**. Do the same for the SFTP client.
3. **`Done()` closes on connection loss and NOT on `Close()`.** An intentional stop must not be
   readable as a lost connection. Getting this backwards makes every clean shutdown look like a
   network failure to the UI.

Also mirror its error vocabulary: a refused session, a refused subsystem and a lost connection
are three different facts and must map to three different errors, exactly as
`ssh_discovery.go` does for exec.

### The measured fact that shapes this

The superseded design claimed "`pkg/sftp` calls are not context-cancellable" and built a
goroutine-plus-deadline scheme on it. That claim is **wrong in one important place**, and the
correction is why this brief exists:

- Of the 39 `*Client` methods in the pinned `github.com/pkg/sftp v1.13.11`, **exactly one public
  method takes a context**: `ReadDirContext` (`client.go:379`). It issues repeated
  `SSH_FXP_READDIR` packets and checks the context on each one. Directory listing is therefore
  natively cancellable and must use it.
- `Stat`, `Lstat`, `Open`, `RealPath` and `File.Read` take no context. Those are what the
  close-to-cancel mechanism is for.

Verify both of those yourself before relying on them — the module is in the module cache. The
previous design's error was believing a claim of this shape without checking it.

### The bounded operation lane

One SFTP client per lease multiplexes all its requests, so cancelling one request must not close
the client out from under the others. Provide a bounded lane that caps concurrent in-flight
calls, and on a hard timeout closes and **poisons** the client, releases its pooled reference,
and reports the lease dead. A poisoned lease is a terminal state that the caller can observe —
not a silent retry loop.

## The claim you must PROVE, not assert

The design records this as an acceptance condition rather than a promise, because the previous
draft promised two things that cannot both be true:

> **Write a test against an SFTP server that accepts requests and never replies, and demonstrate
> that closing the subsystem actually unblocks each non-context call we make.**

If it does, say so with the evidence. If it does **not** for some call, that is a finding, not a
failure — report it plainly, and state which of the two guarantees we must then choose:
"no operation goroutine outlives close" **or** "close returns within a hard deadline". You may
not report both as achieved without the test that shows it.

A fake or in-process SSH/SFTP server is the right tool here. Look at how the existing tests in
`internal/ssh` build their doubles and follow that; do not reach for a new dependency.

## Verify — scoped to your own files

```
go build ./internal/ssh/...
go test ./internal/ssh/...
go vet ./internal/ssh/...
```

Do **not** run `go test ./...`, `golangci-lint run ./...` or `gofumpt -w .`. Formatting is a
separate final wave.

## Tests

- For every external call, a test where it fails: connection refused, subsystem refused, the
  transport dying mid-call, the never-replying server above.
- And the paired test that the ordinary case succeeds. A package here once had tests for every
  failure path and none asserting it worked on a normal machine — where it never had.
- **Interval invariants with both ends named.** Not "Close releases the reference" but "from
  `FSConn` returning until `Close` returns, the pooled reference is held; after `Close` returns,
  it is released and no goroutine from this lease is still running."
- Assert property 3 explicitly: `Close()` must NOT close `Done()`; a transport loss must.

## Ground rules

- **No commit, no push, no branch.** Leave the work uncommitted.
- **Do not touch the issue tracker.** Only the coordinator owns beads.
- **No new dependencies.** `github.com/pkg/sftp` is already a direct dependency.
- Report **numbers, not adjectives**: test count, and specifically the result of the
  never-replying-server test with its actual output. If you could not build that test, say so
  explicitly — silence there will be read as "it passed".

## Lifecycle

Send a `heartbeat` with `--phase` at every phase change (reading DiscoveryConn, lease, lane,
never-replying-server test). One `worker_done` when finished, `--outcome succeeded` or
`--outcome failed`.
