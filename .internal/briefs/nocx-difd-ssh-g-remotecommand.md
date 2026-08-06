# Brief — nocx-difd: `ssh -G` must surface RemoteCommand

You are a supervised worker. Read this whole file before touching anything.

## Ground rules

- **Do not commit, push, or create a branch.** The coordinator integrates.
- **Do not touch the issue tracker (`bd`).** Only the coordinator owns beads.
  `bd show` will not work here anyway — beads lives in a local Dolt database that
  git does not carry, so a fresh worktree has no issue database. Everything you
  need is in this file.
- **Do not run repo-wide gates** — no `go test ./...`, no `golangci-lint run` over
  the repo, no formatting sweep. Formatting is a final single-worker wave.
- **Do run** `go build ./...` and `go vet ./internal/ssh/...`. The build is the Go
  equivalent of a type-check and it is not optional: a test binary can pass while
  a neighbouring file does not compile. If `go build` reports an error in a file
  you do not own, **report it, do not fix it**.
- You own **only** `internal/ssh/ssh_resolver.go` and its test files. No other
  worker is in this worktree, but the coordinator will merge several branches, so
  stay inside those files.
- Report **numbers, not adjectives**: tests before and after, and every problem you
  saw and deliberately left alone.
- Send a `heartbeat` at every phase change (see the end of this file).

## Baseline

`go test ./internal/ssh/...` passes on the commit this worktree was cut from. If
it does not pass when you start, say so immediately and stop — that is a
coordinator problem, not yours.

## The problem

ADR-0015 (`docs/decisions/0015-ssh-g-as-the-ssh-config-oracle.md`) makes `ssh -G`
the single oracle for resolving `~/.ssh/config`. But `HostConfig` in
`internal/ssh/ssh_resolver.go` carries only `HostName`, `User`, `Port` and
`IdentityFile`, and the parser's `switch` recognises only those keys. Everything
else `ssh -G` prints is read and thrown away.

Two of the discarded directives now matter.

**`RemoteCommand`.** When a destination sets it, OpenSSH refuses to also run a
command-line remote command and aborts with _"Cannot execute command-line and
remote command."_ The upcoming shell-integration launcher **is** a command-line
remote command, so on such a host integration is structurally impossible. We must
detect that before connecting, fall back to the configured behaviour, and report
the reason — rather than break a connection that works fine today.

`ssh -G` prints `remotecommand none` when it is unset, so "none" is the sentinel
for absent, not the empty string.

**`RequestTTY`.** Same class of information, same source, needed by the same
caller. Add it in this change so the caller does not have to make a second pass.

## What to build

1. Add `RemoteCommand` and `RequestTTY` to `HostConfig`, populated from `ssh -G`.
2. Teach the parser's `switch` those two keys, normalising `remotecommand none`
   to whatever the empty representation is that you choose — and **document that
   choice in a comment**, because "none" is a legitimate literal command string
   in every other context and the next reader will wonder.
3. Extend the resolver conformance test: a host whose `ssh_config` sets
   `RemoteCommand` resolves with that value; a host without one resolves to the
   empty representation. Do the same for `RequestTTY`.

Follow the conventions already in the file — the existing fields show exactly how
a directive is declared, parsed and tested. Match them rather than inventing a
second style.

## Test first

This repo is TDD, and `AGENTS.md` is emphatic that a test written by reading the
implementation cannot report a missing feature. Write the failing conformance
assertion first, watch it fail, then make it pass.

For every external call there must be a test where that call fails — `ssh -G`
returning nonzero, or printing something unparseable, is an existing concern in
this file; do not regress it.

## When you are done

```bash
orca orchestration send --type worker_done --subject "<one-line status>" \
  --body "<what changed, test counts before/after, anything you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "internal/ssh/ssh_resolver.go,<test files>" --json
```

Use `--outcome failed` if you did not finish. Never encode failure only in prose.

Heartbeat at each phase change:

```bash
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<reading|red|green|verifying>" --json
```

`TASK_ID` and `DISPATCH_ID` are in the message that pointed you here.
