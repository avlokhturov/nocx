# W7 — move the wire to profile IDs (bead nocx-gfh, PR11-T4, P0)

Worker in an Orca wave. The coordinator owns the branch, the commits and the issue
tracker. Work in `/home/dev/orca/workspaces/nocx/pr-11-boundary`.

**Run `bd show nocx-gfh` first and read it in full.** It carries detail this brief does not
repeat, including the exact model shape. This brief covers scope, boundaries and the traps.

## Why

Today the wire carries plaintext credentials outward. The fix is that it carries a profile
ID instead, and the secret is resolved deep inside the SSH package where it is used.

The seam already exists — the PR author built it: `ssh.WithCredentials(store, identity)`
(`ssh.go:139-146`), forwarded by `session.go:274`, resolving the password at
`ssh_auth.go:117-118`. Your job is to route everything through it and delete the RPCs that
hand plaintext back.

## The one hard constraint

**This lands as ONE commit.** Backend contract, frontend migration and removal of the
plaintext-lookup RPCs go together. Split them and there is an intermediate state where SSH
cannot connect at all — the frontend would send IDs to a backend still expecting secrets,
or the reverse. The coordinator will commit; you make the whole change coherent in the
working tree.

## Get the model right

`SSHProfile` is `Base` + `Options` (`profile.go:71-74`). Host, port, user, auth and jump
live under `Options`. `Options.CredentialID` references a reusable `Credential`, and **when
it is set, username / auth / keyPath come from the CREDENTIAL, not from the profile**
(`profile.go:49-56`, `:95-108`). Getting this backwards produces a resolver that silently
connects as the wrong user — it will look like it works until it does not.

The resolver maps `profileID -> {host, credential.Identity, non-secret options}`. Nothing
in `transport`, `session` or `connection` may hold plaintext after this.

## Scope

In: the resolver, the JSON-RPC contract, the frontend calls that used the old shape, and
the removal of the plaintext-lookup RPCs.

Out, and do not drift into them — they are separate beads with their own owners:

- `nocx-l7o` (T7) — the `Secret` type that makes a leak impossible at the type level. It
  comes after you. Do not add it.
- `nocx-1vr` (T10) — the vault's unauthenticated AES-CBC. **Another worker is editing
  `internal/credential/vault.go` right now.** Do not touch that file. If you believe you
  need it, escalate instead.
- `nocx-yaf` (T8) — the connection pool. Do not touch `pool.go`, `ssh_real.go`,
  `ssh_channel.go` or `ssh_dial.go` beyond what the credential routing strictly requires,
  and say in your report if you had to.

## Verification

TDD per `AGENTS.md`: write the failing test first. Then:

- `go test -race ./...`, `gofumpt -l .`, `golangci-lint run`
- frontend: `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npx vitest run`
- Do NOT run the Playwright suite. 13 failures predate this branch (`nocx-bw2`) and are not
  yours; if you want an end-to-end check, the headless devharness path is documented in
  `.internal/reports/devharness-verify.md` — ask the coordinator first.

**Prove the secret does not travel.** A test that asserts the RPC response contains no
plaintext is worth more than any prose in your report. The whole task is that claim.

## Ground rules

- No commits, no pushes, no branches. No `git stash`.
- Do not touch beads / `bd`.
- Do not weaken a security control to make something pass; escalate instead.
- Report numbers, not adjectives. State plainly anything you could not verify.
- Before you report done, diff your own work for accidental removals:
  `git diff HEAD -- <files> | grep '^-'`. Six unrelated things were deleted by accident in
  the previous task on this branch and no gate caught any of them.

## When done

Write `.internal/reports/t4-profile-ids.md`, then `worker_done` from your own terminal with
the `taskId`/`dispatchId` from the dispatch preamble.
