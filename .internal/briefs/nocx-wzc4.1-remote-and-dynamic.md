# Brief — nocx-wzc4.1: remote and dynamic forwarding

Supervised worker. Read this whole file first.

## Ground rules

- **No commit, no push, no branch.** **Do not touch `bd`.**
- **No repo-wide gates.** **Do run** `go build ./...`, `go vet` and
  `golangci-lint run` scoped to the packages you touch. golangci-lint is not
  optional — three waves in this epic shipped findings because their briefs
  forgot to name it, and I fixed them at the merge gate.
- You own `internal/tunnel/` and `internal/ssh/ssh_tunnel.go`. **Other workers
  are live in `internal/shellintegration`, `internal/transport`, `internal/app`
  and `frontend/` — stay out.** If the RPC needs a new field to carry a
  direction, say so in your report; the coordinator sequences it.
- Numbers, not adjectives. Heartbeat each phase.

## Read first

`.internal/specs/2026-08-03-port-forwarding-design.md` §7.2 and §7.3, and the
local strategy `nocx-6nh6` already built. This brief does not repeat either.

## Baseline

`go test ./internal/tunnel/... ./internal/ssh/...` green. Run it and put the
numbers in your report; a baseline you did not measure is not a baseline.

## What to build

The remote (`-R`) and dynamic (`-D`) strategies, behind the interface the model
already has. The direction is chosen at construction — **never** a flag threaded
into one forwarding loop (AD-8). If you find yourself adding `if direction ==`
inside a strategy, the abstraction is in the wrong place.

## Remote: the failure modes are policy, and policy is a fact the user can act on

`Client.Listen` fails for reasons that look identical at the error string and are
completely different to the person reading them:

- `AllowTcpForwarding no` — the admin turned it off. Nothing the user does in
  nocx will help; say that.
- `PermitListen` not matching — the port is refused, another port may work.
- `GatewayPorts no` — sshd silently binds loopback instead of the address asked
  for. **This one does not fail.** It succeeds and does something else, which is
  worse: the user shares a URL that only works on the server. If you cannot
  detect it, the reason field must say the bind address is not guaranteed rather
  than implying it is.

Report the port sshd **actually allocated** when asked for `0` — the request
carries `0`, the reply carries the number, and a panel showing `0` is useless.

## Dynamic: a SOCKS5 server, and the parts people skip

Per accepted connection: negotiate auth (no-auth only; **reject unsupported
methods with `0xFF`**, do not just close), read the request, and open one
`direct-tcpip` channel per CONNECT. BIND and UDP ASSOCIATE get command-not-
supported replies, not a dropped socket — a client that gets EOF reports "the
proxy is broken", a client that gets `0x07` reports the truth.

Map the dial failure to the right reply code: refused is `0x05`, unreachable is
`0x03`, and a generic `0x01` for the rest. Address types: IPv4, IPv6 and
**domain name** — the domain form is the whole point of `-D`, since name
resolution happens at the far end.

One refused CONNECT must leave the proxy serving. Same rule as `nocx-6nh6`'s
trap 4, and the same reason.

## The traps that carried over

Bind before you report success. Do not pre-check that a port is free (TOCTOU).
Own your pool handle and release it when the forward stops — a forward borrowing
the shell's reference dies when an unrelated tab closes (`pool.go:299`).
Connection loss moves the tunnel to `stopped: connection lost` for all three
directions identically; it must not silently rebind.

## Test first

Red before green, and for every external call a test where it fails
(`AGENTS.md` rule 3). `internal/ssh` runs an in-process SSH server in its tests —
use that seam. At minimum: bytes actually cross an `-R` forward from a
remote-side dial; a refused listen surfaces the policy reason; `-R` with port 0
reports the allocated port; a real SOCKS5 handshake reaches a target; an
unsupported auth method gets `0xFF`; BIND gets `0x07`; a refused CONNECT leaves
the proxy alive; connection loss stops both.

A test that asserts your strategy's method was called proves nothing. Carry
bytes.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, test counts before/after, which policy failures you can and cannot distinguish, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<phase>" --json
```
