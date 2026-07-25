# W8 — replace the vault's unauthenticated AES-CBC with an AEAD (bead nocx-1vr, PR11-T10)

Worker in an Orca wave. The coordinator owns the branch, the commits and the issue
tracker. Work in `/home/dev/orca/workspaces/nocx/pr-11-boundary`.

**Run `bd show nocx-1vr` first.**

## Why

`internal/credential/vault.go:97-114` persists bare AES-CBC with no MAC, and `:274-295`
accepts padding after checking only the final length byte. That combination means modified
ciphertext can decrypt successfully into altered plaintext: the encryption is malleable and
unauthenticated. An attacker with write access to the vault file can change what comes out
of it without being detected.

The vault is the non-keychain path — the fallback when no OS keychain is available — so it
is exactly the path used on the machines least likely to have other protections.

## What to build

An AEAD, with **versioned parameters** so the format can be migrated later. Version the
stored blob explicitly; a format that cannot say what it is cannot be replaced without
guessing, and this one will need replacing again.

Decide and record, in a comment at the format definition, the reasoning for:

- the AEAD construction and why,
- nonce generation and how reuse is prevented,
- what is authenticated besides the ciphertext (version, salt, KDF parameters — anything an
  attacker could otherwise swap),
- what happens to vault files written by the old format. If you migrate them, the migration
  must not silently accept forged old-format data; if you refuse them, say so loudly rather
  than failing with a confusing decrypt error.

Failure to authenticate must be indistinguishable from a wrong password to the caller — do
not leak which one it was.

## Boundaries

**You own `internal/credential/vault.go` and its tests, and nothing else.**

Another worker is running in the same worktree on `nocx-gfh` (T4), touching
`internal/ssh/*`, `internal/session`, `internal/transport`, `internal/profile` and the
frontend. Do not edit those. If your change requires one, escalate rather than crossing —
two workers editing one file in a shared worktree corrupts both.

Also out of scope: `nocx-l7o` (T7), the `Secret` type. Its bead says explicitly that T7
changes the type the vault stores but deliberately does not touch this crypto — the
reverse holds too. Do not add the type here.

## Verification

TDD per `AGENTS.md`: the failing test first, and make it the one that matters —
**tampered ciphertext must be rejected**. Flip a byte in the ciphertext, in the tag, and in
the version field, and assert each is refused. A round-trip test alone would pass just as
happily on the broken code you are replacing.

Scope your runs to your own package while the other worker is mid-edit:
`go test -race ./internal/credential/...`. A repo-wide run would compile their half-written
files and report a phantom blocker. The coordinator runs the full gate at the phase gate.
`gofumpt -l internal/credential` and `golangci-lint run ./internal/credential/...` are fine.

## Ground rules

- No commits, no pushes, no branches. No `git stash`.
- Do not touch beads / `bd`.
- Never weaken a control to make a test pass.
- Report numbers, not adjectives: tests added, what each proves.
- Before reporting done, diff your own work for accidental removals:
  `git diff HEAD -- internal/credential | grep '^-'`.
- State plainly anything you could not verify.

## When done

Write `.internal/reports/t10-aead.md` covering the format, the reasoning above, and the
tamper tests. Then `worker_done` from your own terminal with the `taskId`/`dispatchId`
from the dispatch preamble.
