# P7 — the delivery planner (`nocx-qx17`, and `nocx-qwhp`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first, then §3, §5.3 and §5.4
of
[`../specs/2026-08-05-nocxify-delivery-modes-design.md`](../specs/2026-08-05-nocxify-delivery-modes-design.md).

Five packages have landed under you. Read them before writing:

- `frontend/src/ssh-transition.ts` — P4's `SshPlan`: every accepted option as typed, plus an
  exec-ready `oracleArgv`. **You consume it; you do not change its shape.**
- `internal/shellintegration/launcher*.go`, `launch.go` — P6. `launchBundle()` is the shared
  descriptor; the bootstrap publishes, the compact carrier re-proves and fails open.
- `internal/shellintegration/publisher.go` — P1. `Verify()` is how you learn what a host has.
- `internal/ssh/ssh_real.go`, `internal/app/app.go` — P8's wiring, and the shape a saved
  connection now takes.
- `frontend/src/environment-passport.ts` — P2's tracker: `setExpectedEnvironmentId` before
  the line goes out, then `accepted | duplicate | unexpected | ignored`.

## What you build

The decision, made once per attempt, of **which line to send** — and the memory that makes
the second connection cheaper than the first.

1. **A fresh environment id per attempt.** Today `ws_shell_launcher.go` passes the tab's
   stable session id, so two `ssh` attempts from one tab are indistinguishable and P2's
   tracker cannot tell a stale passport from a live one. Mint it in the planner, return it in
   the RPC result, and let the renderer register it as expected _before_ the bytes leave.
   P6 also reports that nothing in the product sets `NOCX_ENVIRONMENT_ID` yet, and that
   `NOCX_SESSION_ID` is not carried on the compact path — both are yours.

2. **An oracle that sees the real command.** `ssh -G` must be invoked with the argv the user
   actually typed (P4 hands you `oracleArgv`), and the per-host cache key becomes the
   resolved identity, not the hostname — ADR-0015 fixed `ssh -G <host>` and a cache keyed by
   host, so **say in your commit that you are narrowing it and why**.

3. **`nocx-qwhp`: a failed oracle must refuse.** `ws_shell_launcher.go` refuses only when
   `ssh -G` succeeds _and_ reports a `RemoteCommand`; when the oracle itself fails the code
   rewrites anyway. ADR-0004 §1 says the opposite. This is a two-line fix with a test that
   fails first.

4. **The installed fact.** Backend-owned, persisted across restarts, keyed by the resolved
   destination identity, recording the protocol version and generation last observed. Written
   only from a passport the renderer accepted — which crosses the control plane as a typed
   observation, and AD-1 currently admits only after-the-fact ledger facts, so **name the
   AD-1 amendment in your commit body**. Invalidated when a connection that expected
   `installed-script` produces no passport: that is how a host whose bundle rotted bootstraps
   again instead of failing forever.

## Files you own

`internal/transport/ws_shell_launcher.go`, `internal/ssh/ssh_resolver.go`, a new
installed-fact store, `internal/app/app.go` wiring, the contract schema for whatever
`shell.launcherCommand` becomes, its generated TypeScript, and the tests for all of it.

`frontend/src/terminal-content.ts` is **P9's** — it will call your method and drive P2's
tracker. Do not edit it; state the RPC shape in your report and P9 wires it.

## What must be true

- a fresh `environmentId` per attempt, returned in the result, never the tab session id.
- the oracle is invoked with the typed argv; the cache key is the resolved identity.
- a failed or unavailable oracle ⟹ the typed bytes go to the pty (`nocx-qwhp`).
- mode `raw` ⟹ no rewrite, no remote write. `relay` behaves as `raw` this epic.
- the installed fact survives a restart, is keyed by resolved identity, and is invalidated
  when the expected passport does not arrive.
- the compact line is chosen only when the fact says installed **and** the protocol version
  is compatible; anything else bootstraps.
- the result shape has its schema in `contracts/` with `additionalProperties: false` and an
  explicit `required`, the generated TS committed, and **both** conformance tests — the DTO
  one and the one that validates the real result off the real socket.

## Verify

`go build ./...`, `go vet`, `gofumpt -l`, `golangci-lint run` on the packages you touched,
`nix shell nixpkgs#dash nixpkgs#zsh --command go test -race ./internal/...` scoped to yours,
and `cd frontend && ./node_modules/.bin/tsc --noEmit` plus `npm run contracts:check`.
Nothing else repo-wide, no formatting passes.
