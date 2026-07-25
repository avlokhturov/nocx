# W13 — wire the connection pool and fix client/jump lifetime (nocx-yaf, PR11-T8)

Worker in an Orca wave. The coordinator owns the branch, the commits and the issue
tracker. Work in `/home/dev/orca/workspaces/nocx/pr-11-boundary`.

**Run `bd show nocx-yaf` first and read it in full**, including the acceptance criteria.

## Why

AD-4 requires a ref-counted `ssh.Client` pool keyed by host+identity, with the connection
closing when the last referencing tab goes away. What exists today is dead code that
believes it is a pool:

- `ConnPool.defaultDial` returns an error, and its own comment calls itself a placeholder
  awaiting "the real wiring".
- Production dials directly in `ssh_real.go` and appends every client to `rc.clients`.
- Channel close in `ssh_channel.go` closes only the session, so clients are released only
  by the global `RealClient.Close` — which ordinary tab closure never reaches.
- Jump clients leak on their own path in `ssh_dial.go`.
- `Acquire`/`Release` are referenced only by the pool's own tests. **The tests exercise an
  implementation nothing calls** — which is why this has stayed broken while looking tested.

So every SSH tab leaks a TCP connection and an authenticated session for the life of the
process, and opening the same host twice authenticates twice.

Two further defects the bead names, and both are sharper than the leak:

- **The key is host/user/port only.** Different identities, or different jump routes to the
  same host, would share one authenticated connection. That is not a resource bug, it is an
  authorization bug: connection reuse across identities means one credential's session
  carries another's traffic.
- **`Release` has no per-handle once guard.** Double-releasing one of two handles drops the
  refcount to zero and closes the connection underneath a live channel belonging to the
  other handle.

## Line numbers in the bead are stale

The bead cites `ssh_real.go:69-77`, `ssh_channel.go:33-38`, `ssh_dial.go:99-103`,
`pool.go:16-22` and `:134-153`. `ssh_real.go` and `ssh_dial.go` both changed today
(`6b6a166`, the credential binding), so those offsets have moved. Find the code by what it
does, not by line number.

## What to build

Production dials through the pool. The key includes identity and the jump route, not just
host/user/port. Closing the last tab that references a connection closes it, **including
the jump transport**. Double release cannot close a connection with a live channel.

Design decisions to make and record in comments, with reasoning:

- **What exactly is in the key.** Enumerate the components and say why each is part of
  identity. If two things differ and you let them share a connection, you have decided they
  are the same principal — make that decision explicitly.
- **How the jump transport's lifetime relates to the target's.** A jump client is itself a
  connection that other tabs may be using. Say whether it is pooled by the same mechanism
  or owned by the target, and what happens when the last target through a bastion closes.
- **What Release does when called twice on one handle.** Idempotent per handle is the
  behaviour required; say how you guarantee it and why that guarantee holds under
  concurrency.

## Verification

TDD per `AGENTS.md`. The acceptance criteria name race tests explicitly, so:

- `go test -race` on everything you touch, and write the concurrent tests to actually
  contend — a test that serialises its goroutines proves nothing about a refcount.
- The double-release test must **fail** on an implementation without the once guard.
  Confirm that, do not assume it; the existing pool tests passing against code nothing
  called is precisely the failure mode this task exists to correct.
- A test that the same host with two different identities gets two connections, and that
  two tabs with the same identity share one.
- A test that the jump transport closes with the last target that needed it.

`internal/ssh` is yours alone right now — no other worker is active. Scope runs to
`./internal/ssh/... ./internal/session/...` if you touch session; the full suite is the
coordinator's job at the phase gate.

## Ground rules

- No commits, no pushes, no branches. No `git stash`.
- Do not touch beads / `bd`.
- Do not weaken a control to make a test pass. In particular, do not widen the key to make
  a test green — a wider key is the authorization bug.
- **`gofumpt -l .` is the gate, not `gofmt`, and run `golangci-lint run` before reporting.**
  The last two workers each reported a clean lint that was not clean; one had two govet
  shadow findings the coordinator had to fix.
- Before reporting done: `git diff HEAD -- internal | grep '^-'` and read every removal.
  Accidental deletion has been the most common defect on this branch and no gate caught one.
- Report numbers, not adjectives. Name any compromise rather than leaving it to be found.

## When done

Write `.internal/reports/t8-conn-pool.md`, then `worker_done` from your own terminal with
the `taskId`/`dispatchId` from the dispatch preamble.
