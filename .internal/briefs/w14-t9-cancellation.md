# W14 — make dial and resize cancellation-safe (nocx-e4g, PR11-T9)

Worker in an Orca wave. The coordinator owns the branch, the commits and the issue
tracker. Work in `/home/dev/orca/workspaces/nocx/pr-11-boundary`.

**Run `bd show nocx-e4g` first, including its acceptance criteria.**

## Why

Cancellation stops at the initial TCP dial and goes no further. Everything after it is a
blocking call that ignores the context:

- The direct and jump handshakes call `gossh.NewClientConn`, which blocks and does not take
  a context, and nothing closes the socket when `ctx.Done()` fires. Cancelling during the
  handshake — the slowest phase, because it is where authentication happens — does nothing
  until the network gives up on its own.
- Jump-target dialing uses `jumpClient.Dial`, which has no context-aware form.
- `ClientConfig.Timeout` does not cover handshakes performed manually, so the one bound you
  might expect to save you does not apply.

In `ssh_channel.go`:

- `closeCb` runs outside `closeOnce`, so repeated or concurrent closes repeat the
  underlying close.
- `Resize` discards its context and can block after disconnect, which breaks AD-7's uniform
  channel/disconnect contract.

The practical shape of this: a user closes a tab while an SSH connection is authenticating,
and the tab does not go away.

## Line numbers are stale — the ground moved twice today

The bead cites `ssh_dial.go:59`, `:154`, `:86` and `ssh_channel.go:33-38`, `:46-54`. Both
files were rewritten since: `6b6a166` (credential binding) and `9d411ec` (the connection
pool, which restructured dialing into per-Connect factories and added a release hook to
channel close). **Find the code by what it does.** Read `9d411ec` before you start —
`dialForConnect`, `dialJumpForConnect`, `dialViaJumpHost` and the pool handle release are
all new, and your change has to fit them rather than the shape the bead describes.

One item is already yours by inheritance: T8 deferred **context cancellation for concurrent
waiters on an in-flight dial** to this task, and recorded it as a stated compromise. It is
in scope here.

## What to build

Cancelling the context during **any** handshake phase closes the socket and returns
promptly. Repeated and concurrent `Close` is idempotent. `Resize` honours its context and
does not block after disconnect.

Decisions to make and record in comments:

- **How a context cancels a blocking call that has no context form.** The usual answer is a
  watchdog goroutine that closes the connection on `ctx.Done()`, which makes the blocking
  call fail. Say how you avoid leaking that goroutine on the success path, and what the
  caller sees — `ctx.Err()`, not the incidental "use of closed network connection".
- **What happens to a pooled entry when a dial is cancelled midway.** T8 made dialing
  pool-mediated; a cancelled dial must not leave a half-built entry or a stranded refcount
  behind, and concurrent waiters on that same key must not inherit a broken connection.
- **What `Resize` does after disconnect.** Returning an error is fine; blocking is not.
  Say which error and why a caller can distinguish it from a transient failure.

## Verification

TDD per `AGENTS.md`. The acceptance criteria name race tests, so `-race` throughout, and
concurrency tests must actually contend — goroutines that serialise prove nothing.

**Every test here must be shown to fail without the fix.** That is not a formality on this
task: T8 existed because a pool's own tests passed for years against code nothing called,
and the double-release guard was only trusted after neutering it and watching three tests
go red. Do the same — disable your fix, record which tests fail, restore, and put both
lists in the report. A cancellation test that passes because the operation was fast is the
easiest wrong-green there is.

Cover at minimum: cancel during the direct handshake; cancel during the jump handshake;
cancel while a second caller waits on the same in-flight pooled dial; repeated `Close`;
concurrent `Close`; `Resize` after disconnect.

`internal/ssh` is yours alone — no other worker is active.

## Ground rules

- No commits, no pushes, no branches. No `git stash`.
- Do not touch beads / `bd`.
- **`gofumpt -l .` and `golangci-lint run` before reporting** — three workers in a row have
  reported a clean lint that was not clean, and the coordinator has had to fix govet
  findings each time.
- Before reporting done: `git diff HEAD -- internal | grep '^-'` and read every removal.
  Accidental deletion remains the most common defect on this branch, and no gate has caught
  a single one.
- Report numbers, not adjectives. Name any compromise instead of leaving it to be found —
  T8 did that correctly with the waiter-cancellation gap, which is why it is now scoped here
  rather than lost.

## When done

Write `.internal/reports/t9-cancellation.md`, including the before/after failure lists from
the mutation checks. Then `worker_done` from your own terminal with the
`taskId`/`dispatchId` from the dispatch preamble.
