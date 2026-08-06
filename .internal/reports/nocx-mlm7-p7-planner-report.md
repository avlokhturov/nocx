# P7 — delivery planner — worker report (task_c7756f0f4c0d)

## What was built

1. **Fresh `environmentId` per attempt** — `internal/transport/ws_shell_launcher.go`
   now mints a 16-byte-hex id (passport charset `[A-Za-z0-9._-]{1,64}`) per
   `shell.launcherCommand` call and returns it in the result. Never the tab
   session id. Minted on every result including refusals.
2. **`NOCX_ENVIRONMENT_ID` + `NOCX_SESSION_ID` on both paths**:
   - Bootstrap: the planner passes `EnvironmentID` into the launcher's
     `LaunchOptions` (new field on `ssh.LaunchOptions`, passed through the
     app.go adapter); the env block already exported both vars.
   - Compact: the launch carrier now exports `NOCX_SESSION_ID="${2-}"`
     (`internal/shellintegration/launch.go`), and `buildInstalledRewrite`
     gained an **optional** third parameter `sessionId` (additive; P4's
     two-arg calls unchanged, all 58 ssh-transition tests still pass). The
     renderer must pass the session id as the carrier's second argument.
3. **Oracle sees the typed argv** — `ssh.ConfigResolver` gained
   `ResolveArgv(ctx, argv)`; the handler passes `plan.oracleArgv` verbatim
   (`["ssh","-G",...options,destination]`, validated at the exec boundary)
   and `ssh -G <argv[1:]>` runs with nothing injected. The resolver cache is
   now keyed by the **resolved identity** (`IdentityKey`: `user@host:port`
   from the ssh -G answer), with an argv→identity index for repeat fast
   paths. **ADR-0015 is narrowed**: the oracle is `ssh -G <typed argv>` and
   the cache/fact key is the resolved identity, not the hostname — say this
   in the commit.
4. **nocx-qwhp** — a failed or unavailable oracle (including a missing
   resolver) now refuses the rewrite with reason `oracle-failed`; the typed
   bytes go to the pty. Test `TestShellLauncherCommand_FailedOracleRefuses`.
5. **The installed fact** — new `internal/ssh/installed_fact.go`
   (`InstalledFactStore`): persisted JSON via `storage.DocumentStore`
   (`installed-facts.json` in the config dir), keyed by `ssh.IdentityKey`,
   fail-closed on corrupt/future-version/unwritable documents. Written only
   from an **accepted passport** reported through the new
   `shell.environmentObserved` RPC, which the backend accepts only for an
   environmentId it minted for a live attempt (expected delivery
   bootstrap/installed — never raw). Invalidated when a report arrives for
   an attempt that expected `installed-script` with no passport.
   **AD-1 amendment this needs** (name in the commit body): AD-1 admits only
   after-the-fact ledger facts across the control plane; §5.4's typed
   observation fact (an accepted passport crossing as an RPC) widens it.
6. **Planner decision** — `mode` ∈ `bootstrap|installed|raw`. Compact line
   chosen only when the fact exists AND `fact.Protocol == "1"`
   (`strconv.Itoa(shellintegration.ProtocolVersion)`); anything else
   bootstraps; refusals are raw. No launcher/stager needed for installed.

## RPC shapes (P9 must wire these)

### `shell.launcherCommand`

```json
params:  { "sessionId": "<AD-7 session id>", "oracleArgv": ["ssh","-G","-p","2222","pi@host"] }
result:  { "mode": "bootstrap"|"installed"|"raw",
           "environmentId": "<fresh per attempt>",
           "launcherPath": "<shell-quoted staged path>"|null,   // bootstrap only
           "reason": null|"remote-command"|"oracle-failed"|"unsupported"|"stage-failed" }  // raw only
```

Renderer contract: register `environmentId` with P2's tracker as expected
**before** the line reaches the pty (bootstrap/installed only — a raw result
must NOT be registered). Bootstrap → `buildBootstrapRewrite(plan,
launcherPath)`; installed → `buildInstalledRewrite(plan, environmentId,
sessionId)`.

### `shell.environmentObserved` (new)

```json
params:  { "environmentId": "<the minted id>",
           "passport": { "protocolVersion","environmentId","parentEnvironmentId",
                         "scriptVersion","tier","generation" } | null }  // null = no passport arrived
result:  { "processed": bool, "factUpdated": bool }
```

Renderer contract: send the **accepted** passport (tracker status
`accepted`) mid-session, or `passport: null` at the local D when the
attempt ended with none. `processed=false` means the id did not match a
live minted attempt (typically post-restart) — log it. Fields are
re-validated against the §5.2 charset/tier at the backend.

## What could not be verified

- **P9's wiring** — `frontend/src/terminal-content.ts` untouched (P9's
  file). Its current call sends `{destination, sessionId}` which now gets
  `-32602` and its `.catch` falls back to the typed line (fail-open, safe);
  its unit tests will be red until P9 updates the params/result usage.
- **A real renderer driving the tracker** — no browser/e2e run; the
  passport→observation round trip is proven through the real WebSocket
  (conformance tests), not through P2's tracker + P9's submit path.
- **Real ssh -G on a real host** — resolver conformance for `ResolveArgv`
  used a scripted ssh binary (argv recording); the existing
  `NOCX_TEST_SSH_G=1` real-ssh suite was not run.
- **Repo-wide gates not run** (per worker rules): no `go test ./...`,
  golangci-lint, gofumpt, prettier, eslint, no commits/pushes.

## Verification (all run)

- `go build ./...` — OK; `go vet` on ssh/transport/app/shellintegration — OK
- `go test -race ./internal/ssh/` — ok; `./internal/transport/` — ok;
  `./internal/app/` — ok
- `nix shell nixpkgs#dash nixpkgs#zsh --command go test -race -count=1 ./internal/shellintegration/` — ok
- `cd frontend && ./node_modules/.bin/tsc --noEmit` — exit 0
- `npm run contracts:check` — pass
- `./node_modules/.bin/vitest run src/ssh-transition.test.ts` — 58/58 pass
- New tests: 8 fact-store, 8 resolver-argv/identity, 18 planner/observation,
  2 environmentObserved conformance, 3 ssh-transition (session-id seam) = 39

## Files modified

Go: `internal/transport/ws_shell_launcher.go` (planner rewrite + observation
handler), `internal/transport/ws.go` (fields + dispatch),
`internal/transport/ws_contract_test.go`, `internal/transport/ws_planner_test.go`
(new), `internal/ssh/ssh_resolver.go` (ResolveArgv/IdentityKey/caches),
`internal/ssh/ssh_resolver_test.go` (stub), `internal/ssh/ssh_resolver_argv_test.go`
(new), `internal/ssh/installed_fact.go` (new), `internal/ssh/installed_fact_test.go`
(new), `internal/ssh/ssh.go` (LaunchOptions.EnvironmentID),
`internal/app/app.go` (fact store wiring + adapter), `internal/app/launcher_reachability_test.go`,
`internal/shellintegration/launch.go` (carrier $2 export).
Contracts/TS: `contracts/shell.launcherCommand.schema.json`,
`contracts/shell.environmentObserved.schema.json` (new),
`frontend/src/generated/*.ts` (regenerated).
Frontend seam: `frontend/src/ssh-transition.ts` (buildInstalledRewrite
optional sessionId), `frontend/src/ssh-transition.test.ts`.

## Deliberately left alone

- `frontend/src/terminal-content.ts` (P9), `frontend/src/environment-passport.ts` (P2).
- `install_remote.go`/`ssh_real.go` P8 wiring untouched (installed-mode
  decision is transport-side; the saved-connection SFTP path still owns its
  own flow).
- The `buildInstalledRewrite` signature extension is the one cross-worker
  seam (P4's file, additive optional param) — flag for the coordinator.
