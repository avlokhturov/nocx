# Wave 5, section A — replay hook + shell pin (task_cf8932902d78)

## What landed

1. **`connectfwd.Replay` wired into the open path** (`internal/transport/ws.go`):
   - `handleOpen` launches `go s.replayStoredForwards(cfg.ProfileID, cfg.Host, cfg.Remote)` **after** the open ack is written — a slow connector acquire can never delay the ack.
   - `replayStoredForwards` loads the profile's own `Options.Forwards` via `s.profiles.LoadProfiles()` (profile-owned, never inherited), calls `connectfwd.Replay` with the whole-resolved-config copy `[]ssh.ConnectOption{func(dst){*dst=*cfg.Remote}}` (identical to `handleTunnelOpen`, AD-4 pool-keying), and registers every result's `Tunnel` in the ledger **without** a tab owner (`trackTunnelConnectionOwned`) — stored forwards are connection-owned and survive tab close (spec §7.3/8). Start-failed rows are still registered so `ports.status` shows them; `tunnel.New`-rejected rows (no record exists) are logged with the row's own error.
2. **Shell pin carried to the launcher**:
   - `internal/session/session.go` `sshOptionsFromConfig`: `if cfg.Shell != "" { opts = append(opts, ssh.WithShell(cfg.Shell)) }` — the pin previously died here and the launcher always received ShellAuto.
   - `handleOpen` honours valid pins (`bash|zsh|unknown|auto`) onto the resolved `ConnectConfig.Shell`; anything else is ignored with a warn, never honoured.
3. **Six through-the-app tests** (`internal/transport/ws_test.go` + 2 session unit tests in `internal/session/session_launcher_test.go`): two stored forwards open both (real bytes through real direct-tcpip channels); a busy local port reports against its own row (stopped+error) while the session stays usable and the other forward keeps forwarding; a row rejected before it becomes a tunnel never stops the next one; a pinned shell reaches the ConnectOptions the registry handed the SSH factory, an unpinned one stays empty (launcher maps "" → ShellAuto), an unknown pin is dropped with a warn.

## Proofs

`deadcode -filter 'nocx/internal/connectfwd' ./...` — verbatim output: **zero bytes, exit 0** (no dead code in internal/connectfwd).

`grep -rn "WithShell(" --include=*.go . | grep -v _test`:

```
./internal/session/session.go:368:		opts = append(opts, ssh.WithShell(cfg.Shell))
./internal/ssh/ssh.go:309:func WithShell(shell ShellKind) ConnectOption {
```

(line 368 is the production caller; 309 is the definition itself.)

## Gates (scoped, no commit/push/bd)

- `go build ./...` — clean
- `go vet ./internal/transport/... ./internal/session/... ./internal/connectfwd/...` — clean
- `gofumpt -l` on all four touched files — clean
- `golangci-lint run ./internal/transport/... ./internal/session/... ./internal/connectfwd/...` — clean
- `go test -race ./internal/session/... ./internal/connectfwd/...` — ok
- `go test -race ./internal/transport/...` (full package, 45s) — ok
- New tests: 6 transport + 2 session, all PASS (verified individually)

## Files modified

- internal/session/session.go (+8)
- internal/session/session_launcher_test.go (+55)
- internal/transport/ws.go (+100, includes the openParams.Shell field from the prior run)
- internal/transport/ws_test.go (+290)

## What's left

Nothing for this section. Worker B/C/D own their files untouched. No commit, no push, no bd per instructions.
