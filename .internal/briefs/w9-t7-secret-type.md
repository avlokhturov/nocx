# W9 — VaultSecret stops being serializable: the Secret type (bead nocx-l7o, PR11-T7)

Worker in an Orca wave. The coordinator owns the branch, the commits and the issue
tracker. Work in `/home/dev/orca/workspaces/nocx/pr-11-boundary`.

**Run `bd show nocx-l7o` first and read it in full.**

## Why

`internal/credential/credential.go:59-64` declares `Value string \`json:"value"\`` — a
secret with a struct tag telling every encoder to write it out. It is a secret designed to
marshal.

T4 (just landed, `fe6e614`) removed the paths that carried secrets outward, and added
`TestNoPlaintextSecretsOnWire` to guard the wire. That guard is behavioural: it fails when
a secret reaches a response. This task is the other half — making the accident impossible
at the type level, so that a future `json.Marshal` of a struct that happens to contain a
secret cannot produce plaintext no matter who writes it.

Redaction protects one encoder at a time. A type boundary is what protects you.

## What to build

`internal/credential/secret.go`: a `Secret` that

- refuses `MarshalJSON` and `MarshalText` — returns an error rather than a redacted string,
  so a caller that tries to serialise one finds out at the call site instead of silently
  shipping `"[REDACTED]"` where a password was expected;
- renders `[REDACTED]` through `String()`, `GoString()` and `LogValue()` — `LogValue`
  matters because `log/slog` is the project's logger and reaches for it automatically;
- exposes plaintext only via `Use(func([]byte) error) error`, so the plaintext's lifetime
  is bounded by a callback rather than handed out.

Then migrate `VaultSecret` to it.

## Scope honestly

The bead says this plainly and it is worth repeating: **this is more than three files.**
It touches the encryption and decryption DTOs, their adapters, and the existing credential
tests. Measured file set from the current tree:

- `internal/credential/credential.go`, `keychain.go`, `vault.go` and their tests
- `internal/ssh/ssh_auth.go` — the one consumer outside the package
- `internal/connection/resolver_test.go` — references the store interface

Do not let the scope creep further. Explicitly NOT in this task:

- the vault's KDF — it hand-rolls PBKDF2 and that is `nocx-dcd`, deliberately separate
  because swapping a KDF needs before/after vector checks or every existing vault becomes
  unreadable;
- the AEAD — `nocx-1vr` landed it in `2f30116`, do not revisit;
- credential-to-host binding (`nocx-mon`) and delete-cascade (`nocx-7l4`).

## The trap

`Use(func([]byte) error)` is only a boundary if nothing copies the bytes out of it. A
helper that does `var s string; secret.Use(func(b []byte) error { s = string(b); return nil })`
reintroduces exactly what the type exists to prevent, and it will look reasonable in review.
Where you need this shape, ask whether the consumer can take the callback instead. Where you
genuinely cannot avoid it, say so in your report with the reason — do not bury it.

## Verification

TDD per `AGENTS.md`. The tests that matter:

- `json.Marshal` of a struct containing a `Secret` returns an error, and the error names
  the type;
- `fmt.Sprintf("%s"/"%v"/"%#v")` and an `slog` record all render `[REDACTED]` and never the
  value — assert on the emitted log bytes, not on a struct field;
- `Use` hands the real plaintext to the callback;
- `TestNoPlaintextSecretsOnWire` in `internal/transport` still passes.

Another worker is active in the worktree on `nocx-1q2` (hygiene): `frontend/**`, whitespace
and `gofumpt` on `internal/profile/profile.go`. You do not share a file with it, but do not
run `npm`/frontend gates — they would observe its half-written files. Scope Go runs to
`./internal/credential/... ./internal/ssh/... ./internal/connection/... ./internal/transport/...`.

## Ground rules

- No commits, no pushes, no branches. No `git stash`.
- Do not touch beads / `bd`.
- Never weaken a control to make a test pass.
- Before reporting done: `git diff HEAD -- internal | grep '^-'` and read it. Accidental
  deletions have been the most common defect on this branch and no gate has caught one yet.
- Report numbers, not adjectives. State plainly anything you could not verify.

## When done

Write `.internal/reports/t7-secret-type.md`, then `worker_done` from your own terminal with
the `taskId`/`dispatchId` from the dispatch preamble.
