# Brief — nocx-6nh6: the tunnel model and local forwarding

Supervised worker. Read this whole file first.

## Ground rules

- **No commit, no push, no branch.** The coordinator integrates.
- **Do not touch `bd`** — its database does not travel with git; everything you
  need is here and in the tracked spec.
- **No repo-wide gates.** **Do run** `go build ./...`, `go vet` and
  `golangci-lint run` **scoped to the packages you touch**. golangci-lint is not
  optional: two earlier waves in this repo shipped findings because their briefs
  forgot to name it.
- You own a **new** package (`internal/tunnel` or similar — your call, justify
  it) plus whatever `internal/ssh` needs to expose. **Other workers are live in
  `internal/shellintegration`, `internal/app` and `frontend/` — stay out.**
  If you must touch `internal/ssh/ssh.go`, keep it minimal and say so.
- Numbers, not adjectives. Heartbeat each phase.

## Read first

`.internal/specs/2026-08-03-port-forwarding-design.md` §7 and §7.1 — tracked, in
your worktree. This brief does not repeat it.

## Baseline

`go test ./internal/ssh/... ./internal/session/...` green, ~1.4s and ~1.1s.

## What to build

The `Tunnel` domain type and the **local** strategy behind it.

The model covers all three directions **now**, even though only local is
implemented, because `-R` brings remote-listener policy and `-D` brings SOCKS
semantics — a direction flag threaded into one forwarding loop collapses under
both. AD-8: a strategy behind an interface, never a switch inside an
implementation. The spec §7 lists the fields; carry all of them.

## The five traps, in the order they bite

1. **Bind before you report success.** `EADDRINUSE`, a bad address and a
   permission error are synchronous, user-visible failures — not something
   discovered later by a goroutine.
2. **Do not pre-check whether the port is free.** That is a TOCTOU race. Attempt
   the listen and report what the OS said.
3. **Port `0` means "allocate one" — report the ACTUAL port.** A panel that
   shows `0` is useless, and the number only exists after the bind.
4. **Each accepted connection gets its own `direct-tcpip` channel.** One stream
   failing — a remote target refusing the connection — must not kill the
   listener. This is the difference between "that request failed" and "your
   tunnel vanished".
5. **Own your pool handle.** `internal/ssh/pool.go` is ref-counted and the
   tab-owned reference is released when the shell channel closes
   (`ssh_real.go:148`, `pool.go:299`). A forward that borrows the shell's
   reference dies when that tab closes — including when a _different_ tab is
   using the tunnel. Take your own handle; release it when the forward stops.

Default bind is **`127.0.0.1`**, never `0.0.0.0`. `localhost` is ambiguous
across systems, so IPv4 loopback, IPv6 loopback and all-interfaces are explicit
choices, and the last one is an advanced option carrying a warning.

Connection loss moves a tunnel to `stopped: connection lost`. It must **not**
silently rebind and must not claim to still be running — reconnect belongs to
`nocx-9le.7` and this task must not assume it.

## Test first

Red before green. For every external call there is a test where it fails
(`AGENTS.md` rule 3): a busy local port, port 0 reporting the real port, a
refused remote target leaving the listener alive, connection loss, and a tab
teardown that stops only its own forwards. `internal/ssh` already runs an
in-process SSH server in its tests — use that seam rather than building one.

## Explicitly out of scope

Discovery. The panel. The block offer. Stored profile forwards. The `-R` and
`-D` implementations — but **not** their place in the model.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, test counts before/after, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<phase>" --json
```
