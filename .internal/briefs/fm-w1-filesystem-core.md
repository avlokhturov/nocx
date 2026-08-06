# W1 — `internal/filesystem`: the provider contract, the local provider, the binding registry

## Where you are

You are in your OWN git worktree. **Run `pwd` first and use that path for everything.**
Never write to `/home/dev/orca/workspaces/nocx/feat-file-manager-2` — that is the
coordinator's checkout and writing there splits your work across two trees.

## Read this first

`.internal/specs/2026-08-06-file-manager-design.md` — it is committed in your worktree. It is
the design and it is binding. Read **§5.1 in full**, plus D1, D3, D8, D9, D14, D15 in §3.

The issue tracker is NOT in your worktree; `bd` will find nothing. Everything you need is in
this brief and in that spec.

## What you own — and nothing else

**You own `internal/filesystem/**` and nothing outside it.** Do not touch `internal/ssh`,
`internal/session`, `internal/transport`, `internal/app`, `contracts/` or anything under
`frontend/`. Other workers own those. If you believe you need a change outside your package,
**escalate instead of making it**.

You are writing a package with no caller yet. That is expected: W4 wires it into transport in
the next wave. Do not add a caller, do not edit `internal/app/app.go`.

## Build it

### 1. The types and the `Provider` interface — §5.1

Exactly as the spec declares them: `Provider`, `Root`, `Page`, `Entry`, `Kind`, `Listing`,
`Content`, `Watch`/`WatchMode`. Note carefully:

- **`Kind` is an enum, not two booleans**: `regular | dir | symlink | other`, plus `LinkTarget`
  and `LinkKind` on symlinks. The openability table in §5.1 is the contract — implement it as
  a function so there is one place that decides, and **enforce it from metadata read at call
  time**, never from a value a caller passed in. A symlink can be retargeted between a list and
  a read.
- **There is no `Entry.Cycle`.** Cycle detection is the frontend's, using `Listing.Canonical`.
  Do not add it.
- **`Listing.Canonical` is returned for every successful list**, not only for symlinks, and the
  provider resolves the canonical directory and lists _that_, in that order.
- **`Listing.Entries` is never nil** — an empty directory is `[]`.
- **Ordering is yours and it is deterministic**: directories first, then files, each by UTF-8
  byte order of the name, case-sensitive, applied BEFORE pagination.
- **`Rev`** is a cheap digest over each entry's name, size, mtime, mode, kind, **LinkTarget and
  LinkKind**. The last two matter: a symlink retargeted to another file of the same size and
  kind must change the digest.

### 2. The local provider

`path/filepath` rules. Reading is bounded and streamed exactly as §5.1 says: effective limit is
`min(requested, 2 MiB)`, read at most `limit+1` bytes and **never the whole file** — this must
hold for a 40 GB file. `Truncated` iff the extra byte was readable. Sample size and mtime before
and after and set `Changed` on a difference. `Binary` is the NUL heuristic and when it is true
`Text` is empty. `Text` is always valid UTF-8 with `Lossy` set when sequences were replaced —
never base64.

**The two directory caps of D14**, both of them, with distinct outcomes: `tooLarge{observedCount,
limit}` and `timedOut{timeout}`. Partial results are discarded, never returned as if complete.
Do not report an exact `observedCount` you did not actually pay for.

### 3. The binding registry — §5.1 "Bindings", D1, D15

`Binding` with **unexported fields** and `ID()`/`EndpointID()` accessors. A `Handle` interface
as the spec declares. A `Caller` interface (`Owns(sessionID) bool`) declared **here**, in
`filesystem` — `transport` will satisfy it later; you must NOT import `transport`, and doing so
would invert the dependency.

`Registry.Acquire(id string, c Caller) (Handle, func(), error)` is **the only route to a
filesystem**. Nothing outside the package may obtain a bound provider. This is structural: it is
what makes "a handler cannot forget the check" true rather than a discipline.

Acquire holds a use-guard for the handle's lifetime; close waits on it; the handle is invalid
after release. Binding ids come from `crypto/rand`.

Leave `EndpointID` empty for local. The SFTP provider is W5's, in a later wave — but design the
seams so it drops in without changing this package's exported surface.

## Verify — scoped to your own files

```
go build ./internal/filesystem/...
go test ./internal/filesystem/...
go vet ./internal/filesystem/...
```

Do **not** run `go test ./...`, `golangci-lint run ./...`, `gofumpt -w .` or any repo-wide gate.
Other workers have half-written files in this tree and you will report their errors as yours.
Formatting is a separate final wave — do not run it.

## Tests — the standard this repo holds

From `AGENTS.md`, and these are not optional:

- **Every external call has a test where it fails.** Permission denied, ENOENT, a directory
  larger than one page, a file over 2 MiB, a binary, a NUL at byte 9000, invalid UTF-8, a file
  that changes size mid-read, a FIFO, a symlink to a regular file, a broken symlink, a directory
  above the entry cap.
- **And for every one of those, the paired test that the ordinary case succeeds.** A suite of
  only failure paths has been shipped here before and it hid a function that never worked.
- **Interval invariants, both ends named.** "From Acquire until release, the handle is valid;
  after release, every method on it errors" — assert both ends, not just the first.
- Do not write a test that asserts what your implementation happens to do. Write it from the
  spec section, then make it pass.

## Ground rules

- **No commit, no push, no branch.** Leave your work uncommitted in the worktree.
- **Do not touch the issue tracker.** Only the coordinator owns beads.
- Report **numbers, not adjectives**: test counts, what you could not verify, and every decision
  you made that the spec did not make for you.
- If the spec is wrong or silent on something load-bearing, **escalate** — do not invent and do
  not quietly pick. The spec has been through seven adversarial rounds; a gap in it is
  interesting, not routine.

## Lifecycle

Send a `heartbeat` with `--phase` at every phase change (types, local provider, registry,
tests). Without it there is no way to tell slow from dead, and an exited pane loses its
scrollback entirely.

One `worker_done` when finished, with `--outcome succeeded` or `--outcome failed`.
