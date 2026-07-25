# W12 — deleting a credential deletes its secrets (nocx-7l4, PR11-T6)

Worker in an Orca wave. The coordinator owns the branch, the commits and the issue
tracker. Work in `/home/dev/orca/workspaces/nocx/pr-11-boundary`.

**Run `bd show nocx-7l4` first and read it in full.**

## Why

`internal/transport/ws.go:998-1010` deletes credential metadata only. The keychain entry
survives, permanently orphaned: the user deletes a credential, the UI shows it gone, and
the password is still sitting in the OS keychain with nothing left in the app that can ever
reach it — so it cannot be deleted through the UI either. A secret the user believes they
destroyed is the worst kind of leftover.

## The ordering trap — this is the whole task

The two secret kinds are keyed differently:

- a **password** keys on `Identity{User: credentialID}` — derivable from the ID alone;
- a **key passphrase** keys on `KeyHash` — derived from the key material, and the metadata
  stores only `KeyPath`.

So once the metadata row is gone there is no `KeyPath` left, no hash can be derived, and
the passphrase is unreachable forever. **Load the metadata BEFORE deleting it**, derive
everything you need, and only then remove.

Get this backwards and the code will look correct, the tests will pass if they only check
the password path, and the passphrase will leak silently.

## What to build

Delete the metadata and every secret it references, in an order that cannot strand one.

Decide and record, in the code, with reasoning:

- **What happens if metadata deletion succeeds and secret deletion fails**, or the reverse.
  One of the two orders strands a secret and the other strands metadata; say which you
  chose and why that failure is the better one to have.
- **Whether a missing secret is an error.** Deleting a credential that never had a password
  saved must not fail. "Already absent" and "deleted" should converge.
- **Whether other profiles can still reference the credential.** If they can, deleting its
  secrets breaks them — check whether the model allows it and say what you found.

## Verification

TDD per `AGENTS.md`. The tests that matter:

- save a password, delete the credential, assert the keychain entry is **gone** — query the
  store directly, not through the API you just changed;
- the same for a key passphrase, and this one must fail on the naive
  delete-metadata-first implementation. If it passes both before and after your change,
  it is not testing the trap;
- deleting a credential with no secrets saved succeeds;
- delete is idempotent.

Scope Go runs to `./internal/transport/... ./internal/credential/...`. Another worker is
active on `nocx-mon` in `internal/connection/**` and `internal/profile/**` — a repo-wide
run would compile its half-written files and report a phantom blocker.

Note `internal/credential` changed under you very recently: `LookupPassword` and
`LookupPassphrase` now return a `Secret` (a90e31e, `nocx-l7o`), which refuses to serialise
and yields plaintext only through `Use`. Read `internal/credential/secret.go` before you
touch anything there. **Do not copy bytes out of `Use` into a string** — that reintroduces
exactly what the type exists to prevent, and this task should not need plaintext at all:
deleting a secret does not require reading it.

## Ground rules

- No commits, no pushes, no branches. No `git stash`.
- You own `internal/transport/ws.go` and `internal/credential/**`. Do not touch
  `internal/connection/**` or `internal/profile/**` — the other worker owns them.
  Escalate instead of crossing.
- Do not touch beads / `bd`.
- Before reporting done: `git diff HEAD -- internal | grep '^-'` and read it.
- **`gofumpt -l .` is the gate, not `gofmt`.**
- Report numbers, not adjectives. Name any compromise in the report rather than leaving it
  to be found.

## When done

Write `.internal/reports/t6-delete-cascade.md`, then `worker_done` from your own terminal
with the `taskId`/`dispatchId` from the dispatch preamble.
