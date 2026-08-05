# P2 — the readiness passport and tagged markers (`nocx-tyfu`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first, then §5 of
[`../specs/2026-08-05-nocxify-delivery-modes-design.md`](../specs/2026-08-05-nocxify-delivery-modes-design.md).
§5.1 says why an unnamed marker cannot do this job; §5.2 is the format you implement on both
sides.

## What you build

A shell announcing "I am nocx's integration, in environment `<id>`, at tier `<t>`" — and a
renderer that believes it only when the id is the one nocx expected.

Today `renderers/xterm.ts` hands up bare `A/B/C/D` plus an exit code, so three real
sequences are indistinguishable and each breaks the product: the POSIX tier opens with an
orphan `D;0` before its first A; the first remote command's D looks exactly like leaving the
ssh environment; and an already-integrated tmux emits markers that belong to nobody nocx
launched.

## Files you own

- `internal/shellintegration/scripts/nocx.bash`, `nocx.zsh`, `nocx.posix`
- `internal/shellintegration/scripts.go`, `scripts_version_test.go`
- `frontend/src/renderers/xterm.ts`, plus a new frontend protocol module and its tests

Nobody else touches these in this wave. Do not edit `launcher*.go` (P6),
`terminal-content.ts` (P9), or anything under `internal/shellintegration/` that P1 is
creating.

## The format

```
OSC 636 ; P ; <protocolVersion> ; <environmentId> ; <parentEnvironmentId> ; <scriptVersion> ; <tier> ; <generation> ST
```

OSC 636 is already nocx's private OSC — `S` is the command-existence snapshot and `H` the
session hello, both in `nocx.bash`. `P` joins them; keep the existing two working.

- positional, semicolon-separated, every value `[A-Za-z0-9._-]{1,64}`, so no escaping is
  needed and none is invented. `parentEnvironmentId` is `-` at depth 0; `generation` is `-`
  when nothing was published; `tier` is `enhanced|blocks|minimal`.
- the sequence is bounded at 512 bytes. Longer, malformed, or an unknown `protocolVersion`:
  **ignored**, never guessed at, never partially applied.
- lifecycle markers become `OSC 133 ; A ; nocx_env=<environmentId> ST` and likewise B, C, D
  — the `;key=value` parameter form OSC 133 already permits, so a foreign terminal is
  unaffected. An **untagged** marker must keep driving block boundaries exactly as today.
- a duplicate passport for an already-accepted id is ignored; an id that is not the expected
  one is ignored and logged.

The renderer side is parse-and-report only: it exposes the passport and the tag to whoever
asks (P9 will consume it). **Do not change environment or ownership behaviour in
`terminal-content.ts` — that file is P9's**, and wiring it now would collide.

## What must be true when you are done

- a valid passport with the expected id parses into a typed value with every field.
- over-long, malformed, unknown-protocol, duplicate and unexpected-id passports change
  nothing and are not reported as valid.
- tagged A/B/C/D expose their `nocx_env`; untagged ones expose none and still drive blocks.
- the three shells actually emit both. Not a golden string in a Go test — **run the shells**:
  `scripts_exec_test.go` and `scripts_posix_exec_test.go` already show the pattern, and
  `nix shell nixpkgs#dash nixpkgs#zsh --command go test ...` is how dash and zsh get onto
  PATH on this machine.
- the script version is bumped and `scripts_version_test.go` carries the new digest. The
  current version is 10 — read `scripts.go` rather than trusting any prose.
- a shared golden fixture set is used by both the Go and the TypeScript tests, so the two
  sides cannot drift.

## Verify

`go build ./...`, `go vet ./internal/shellintegration/`,
`nix shell nixpkgs#dash nixpkgs#zsh --command go test -race ./internal/shellintegration/...`,
`cd frontend && ./node_modules/.bin/tsc --noEmit`, and vitest scoped to your files only.
