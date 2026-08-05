# Brief — nocx-wzc4.1, follow-up: prove it against a real server

Your report is good and both requests in it are granted. Keep working in the
same worktree; nothing you built is in question.

## 1. Ownership relaxed — write the real-seam tests

You may create **new test files** in `internal/ssh` (e.g. `ssh_tunnel_remote_test.go`)
and extend the in-process test SSH server with whatever it needs — including the
`tcpip-forward` global request handler if it does not have one. Another worker
holds `internal/ssh/ssh_real.go` and `internal/ssh/ssh.go`; stay out of those two
and out of `ssh_real_test.go`. Everything else in that package's test
infrastructure is yours for this pass.

This matters because of a rule this repo paid for: a test that drives your own
fake seam proves the strategy calls what you wrote, not that a forward works.
Two claims are currently unproven:

- **`-R` carries bytes.** A remote-side dial to the server's listener reaches a
  local destination, and the payload arrives intact.
- **`-D` carries bytes.** A real SOCKS5 client handshake through the proxy
  reaches a target over a real `direct-tcpip` channel — not a table test of the
  reply bytes, which you have and which stays.

Also prove against the real server the two facts you inferred from upstream:
port `0` reports the port sshd actually allocated, and a refused listen surfaces
your policy-worded reason.

If the in-process server cannot be made to do `tcpip-forward` without more
surgery than this is worth, **say so with what you tried** and leave the fake
seam tests in place. A measured "this seam does not exist" is a fine answer; an
unmeasured claim is not.

## 2. The bind caveat — add the field

You are right that `GatewayPorts no` is the dangerous one precisely because it
succeeds. Add the additive field yourself (your `Caveat() string` suggestion is
the right shape) and set it from the remote strategy for non-loopback binds.

The wording must say what is true: the bind address was requested and is not
verified, so a URL built from it may only work on the server. It must not say
"failed", because nothing failed.

If the field crosses the wire, it needs its schema entry, the generated renderer
type and the conformance test in the same pass (`AGENTS.md` rule 5) — and
`contracts/tunnel.open.schema.json` has `additionalProperties: false`, so a new
field that skips the schema will fail the conformance test rather than slip
through. The panel worker will render it; note the field name in your report so
the coordinator can hand it over.

## Gates

As before: `go build ./...`, `go vet`, `golangci-lint run` and `gofumpt -l`
scoped to what you touch, plus `-race`. If you touch a contract, add
`cd frontend && npm run contracts:check`. No commit, no push, no `bd`.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<what the real-seam tests prove, test counts, the caveat field name, anything still unverified>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
```
