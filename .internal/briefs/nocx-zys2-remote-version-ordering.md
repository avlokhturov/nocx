# Brief — nocx-zys2: the remote installer writes VERSION before the gates

You are a supervised worker. Read this whole file before touching anything.

## Ground rules

- **Do not commit, push, or create a branch.** The coordinator integrates.
- **Do not touch the issue tracker (`bd`).** Beads lives in a local Dolt database
  that git does not carry, so a fresh worktree has no issue database — `bd show`
  finds nothing. Everything you need is here.
- **Do not run repo-wide gates** — no `go test ./...`, no repo-wide lint, no
  formatting sweep. Formatting is a final single-worker wave.
- **Do run** `go build ./...` and `go vet ./internal/shellintegration/...`. The
  build is the Go equivalent of a type-check and is not optional. An error in a
  file you do not own: **report it, do not fix it**.
- You own **only** `internal/shellintegration/install_remote.go` and its tests.
- Report **numbers, not adjectives**.
- Heartbeat at every phase change (see the end).

## Baseline

`go test ./internal/shellintegration/...` passes on the commit this worktree was
cut from — measured, 4.2s. If it fails when you start, say so and stop.

## The bug

`EnsureInstalledRemote` in `internal/shellintegration/install_remote.go` writes
the `VERSION` marker immediately after copying the scripts and **before** the
loop that appends the gate line to the remote `~/.bashrc` / `~/.zshrc`. The same
function early-returns whenever the installed version already matches.

So one failed gate append — a read-only rc file, a permissions problem, an
interrupted transfer — leaves a marker claiming the current version is installed.
Every future connection then short-circuits on that marker and never retries. The
host is left with the scripts on disk, no gate to source them, and no way back:
integration is silently off forever.

**The fix already exists for the local path.** `EnsureInstalled` in
`internal/shellintegration/shellintegration.go` writes the version **last**, and
only when every gate append succeeded, with a comment explaining precisely this
failure (it was bought by bead `nocx-1dx`). The remote twin never received it.

## What to build

Make the remote path behave like the local one: the `VERSION` marker is written
only after every rc gate append has succeeded. Mirror the local implementation's
shape and its reasoning — do not invent a third pattern. Read
`EnsureInstalled` first; the structure you want is already there.

Note that the two functions differ in how they report a partial failure (the
local one logs a warning per file and carries a `gatesOK` flag). Keep the remote
one's existing best-effort logging contract — errors are logged, not fatal — and
change only _when_ the marker is written.

## Test first

Red before green, per `AGENTS.md`. The assertion that matters is the one about
**recovery, not the moment of failure**:

> with a gate append that fails, a second `EnsureInstalledRemote` call **retries**
> instead of short-circuiting on a matching version.

A test that only asserts "VERSION was not written" checks the start of the
interval and would pass against a half-fix. State the invariant with both ends.

The existing tests in this package show how the SFTP client is faked; follow that
seam rather than building a new one.

## When you are done

```bash
orca orchestration send --type worker_done --subject "<one-line status>" \
  --body "<what changed, test counts before/after, anything you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "internal/shellintegration/install_remote.go,<test files>" --json
```

`--outcome failed` if you did not finish. Never encode failure only in prose.

```bash
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<reading|red|green|verifying>" --json
```

`TASK_ID` and `DISPATCH_ID` are in the message that pointed you here.
