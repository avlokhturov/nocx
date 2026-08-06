# nocx-wzc4.1 — remote (-R) and dynamic (-D) strategies — worker report

Task: task_c46f22b3a1c3 / dispatch ctx_a2e0db1abd8f. Date 2026-08-04.

## What changed

Production (all within ownership: `internal/tunnel/`, `internal/ssh/ssh_tunnel.go`):

- **`internal/ssh/ssh_tunnel.go`** — added `Listen(addr string) (net.Listener, error)` to the
  `TunnelConn` interface and implemented it on `tunnelConn` (gossh `client.Listen("tcp", addr)`),
  with the same closed/done guards as `Dial`. The server's refusal surfaces unmodified.
- **`internal/tunnel/lifecycle.go`** (new) — `forwardLifecycle`, the shared lease/listener/
  streams/teardown machinery local, remote and dynamic all use (spec §7.3): one lease per
  forward, one shutdown path, `stopped: connection lost` on transport death, no silent rebind.
- **`internal/tunnel/local.go`** — refactored onto the lifecycle (no behavior change; all 8
  prior tests still pass).
- **`internal/tunnel/remote.go`** (new) — `-R` strategy: `lease.Listen` for the remote
  listener, policy-wrapped refusal on failure, server-allocated port reported for port 0,
  destination dialed **locally** (`net.Dial`) per OpenSSH `-R` semantics.
- **`internal/tunnel/dynamic.go`** (new) — `-D` strategy: local SOCKS5 server. No-auth only;
  unsupported methods rejected with the exact two-byte `[0x05, 0xFF]` method reply (not the
  10-byte request envelope); BIND/UDP ASSOCIATE answered `0x07`; CONNECT targets dialed as
  direct-tcpip channels with the domain form forwarded verbatim (far-end resolution); dial
  failures mapped `0x05` refused / `0x03` unreachable / `0x01` generic (syscall errno chain
  - OpenSSH's "connect failed: …" rejection text); one refused CONNECT leaves the proxy
    serving; handshake reads bounded by a 10 s deadline.
- **`internal/tunnel/tunnel.go`** — `strategyFor` wires remote/dynamic; `New` rejects a
  destination on a dynamic forward; direction docs updated.
- Tests: `internal/tunnel/tunnel_test.go` (fake connector gained a `Listen` seam modeling
  the server's tcpip-forward), `internal/tunnel/dynamic_internal_test.go` (new, package
  `tunnel`): protocol table tests asserting exact reply bytes, reply-code mapping.

## Test counts

- Baseline (measured before any change): tunnel 9, ssh 127 — both green.
- After: tunnel **24** (`-race` green), ssh **127** unchanged (`-race` green) — the
  `TunnelConn` interface addition broke no other implementer (only `tunnelConn` and the
  test fake implement it).
- Gates: `go build ./...`, `go vet`, `gofumpt -l`, `golangci-lint run ./internal/tunnel/... ./internal/ssh/...` — all clean.

## Policy failures: what is distinguishable, what is not

- `AllowTcpForwarding no` and `PermitListen` mismatch are **indistinguishable on the wire**
  (both are the `tcpip-forward` request reply false). The `-R` start error names both and
  says another bind may work — the reason is actionable even though the two cases cannot be
  split.
- **`GatewayPorts no` is not detectable at all** — the listen succeeds and sshd silently
  rebinds. The strategy reports the transport's answer (requested host, or `0.0.0.0` for a
  hostname) with the confirmed port, and the contract documents that the bound host is
  never verified. **Sequencing request:** the model has no field for a success-time bind
  caveat; if the Ports panel must show "bind address not guaranteed" for non-loopback `-R`
  requests, the coordinator should sequence a small additive field (e.g. `Caveat() string`
  on the tunnel record, set only by the remote strategy for non-loopback binds). I kept the
  API unchanged per scope; the wording lives in `remote.go`'s contract comments until then.
- RPC: no new field was needed here; direction was already on the wire (`Spec.Direction`).

## What I could not verify

- **Real tcpip-forward over a live SSH server.** The ownership boundary (`internal/tunnel/`
  and `internal/ssh/ssh_tunnel.go` only, shared `internal/ssh` test infrastructure out of
  bounds) prevented a seam test against the in-process server; all `-R` tests drive the
  fake `Listen` seam. The gossh `Client.Listen` reply-parsing (port 0 → allocated port in
  `Addr()`) is upstream-tested; the wrapper is 10 lines mirroring `Dial`'s guards. If a
  real-seam test is wanted, the coordinator must relax ownership for one new test file in
  `internal/ssh`.
- GatewayPorts: impossible from the wire (above).

## Notes for other workers

- `transport`/`app`: `Spec.Direction` already carries `remote`/`dynamic`; no contract
  change. Dynamic forwards must have an empty `Destination` (now validated).
- `-R` destinations resolve on the client's network; `-D` and `-L` destinations resolve on
  the server's network — surfaced to the user, the two must not be conflated.
