# nocx-wzc4.1 — follow-up: real-seam proofs + bind caveat — worker report

Task: task_d357d1e4c4ac / dispatch ctx_92e9ce184b0d. Date 2026-08-04.

## What the real-seam tests prove

**`-R` carries bytes (production strategy, real server).** The in-process server in the tunnel
tests (`realSeamServer`, `internal/tunnel/tunnel_real_test.go`) answers `tcpip-forward` /
`cancel-tcpip-forward` global requests, binds a real loopback listener, and delivers accepted
connections to the client as `forwarded-tcpip` channels — the exact OpenSSH data path. The
production `remote` strategy runs over a real `ssh.RealClient` connection:
`TestRemoteStrategy_RealServer_CarriesBytes` dials the server's listener from the "remote
machine", and the payload arrives intact at the local echo destination and back. Port 0 is
resolved by the SERVER and reported: `tun.Actual().Port == srv.lastAllocatedPort()`.

**`-D` carries bytes (real SOCKS5 client, real server).**
`TestDynamicStrategy_RealServer_RealSOCKS5Client` runs the production `dynamic` strategy over a
real connection and drives it with a wire-speaking SOCKS5 client (`socks5Connect` helper: real
socket, greeting → method → CONNECT state machine). CONNECT by IPv4 and by domain name (the
domain forwarded verbatim, resolved by the server — the point of -D) both reach the echo target
and round-trip payload. A refused CONNECT answers `0x05` — the server's pre-Accept dial rejects
the direct-tcpip open with "connect failed: Connection refused", which the mapping string-matches
— and the proxy keeps serving.

**Refused listen, policy-worded.** `TestRemoteStrategy_RealServer_RefusedListen` (server
`AllowTcpForwarding` off): `Start` fails with the reason naming "refused by server",
"AllowTcpForwarding" and "PermitListen"; record is `stopped/error`.

**Transport-level seam in internal/ssh** (`ssh_tunnel_remote_test.go`, `forwardTestSSHServer`):
`TestTunnelConn_Listen_CarriesBytes` (forwarded-tcpip channel carries bytes, port 0 from the
reply), `TestTunnelConn_Listen_RefusedByPolicy` (both `AllowTcpForwarding no` and a
`PermitListen` hook refusal surface "denied by peer" — the indistinguishable pair), and
`TestTunnelConn_Listen_HostnameReportsZeroIP` (hostname bind reports `0.0.0.0`, the basis for
the caveat).

## The bind caveat — field name: `Caveat`

- `internal/tunnel`: `Tunnel.Caveat() string` accessor, set on successful start from the
  strategy's `caveat()`. Only `remote` sets it: non-loopback requested binds
  (`isLoopbackHost`: 127/8, `::1`, `localhost` clean; any other hostname/address caveated).
  Wording: "bind address %s requested but not verified: the server may have bound a different
  address (GatewayPorts), so a URL built from this forward may only work on the server" — a
  disclosure, never "failed". `local`/`dynamic` return "".
- Wire: `tunnelRecord.Caveat` (`json:"caveat"`) in `tunnel.open`/`tunnel.stop` results; both
  schemas gained the required `caveat` string; `frontend/src/generated/tunnel.{open,stop}.ts`
  regenerated (`caveat: string`). Conformance: new `running-remote-with-caveat` DTO case with
  non-empty text, `Caveat` on the stop case, and the over-the-wire test pins the local-open
  caveat is present-and-empty. Panel worker should render `caveat` when non-empty.
- Caveat is based on the REQUESTED bind host, never `Actual()` — the whole point is that the
  actual host is unverifiable.

## Test counts and gates

- tunnel: 24 → **30** tests (4 new real-seam + 2 pre-existing subtests counted), ssh: 127 → **130**
  (3 new). `go test -race` green on `internal/tunnel`, `internal/ssh`, `internal/transport`.
- Gates: `go build ./...`, `go vet`, `gofumpt -l`, `golangci-lint run` (tunnel/ssh/transport)
  all clean; `cd frontend && npm run contracts:check` and `tsc --noEmit` clean.
- No commit, no push, no bd — per brief.

## Still unverified

- GatewayPorts behavior itself: impossible from the wire (the listen succeeds either way); the
  caveat is the product answer. Nothing else unverified from the brief's list.
