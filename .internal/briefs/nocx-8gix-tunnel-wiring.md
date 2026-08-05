# Brief — nocx-8gix: the tunnel must be reachable from `main()`

Supervised worker. Read this whole file first.

## Ground rules

- **No commit, no push, no branch.** **Do not touch `bd`.**
- **No repo-wide gates.** **Do run** `go build ./...`, `go vet` and
  `golangci-lint run` scoped to what you touch, plus, since you add a contract,
  `cd frontend && npm run contracts:check` and `./node_modules/.bin/tsc --noEmit`.
- You own `internal/app/`, `internal/transport/`, `contracts/` and the generated
  renderer type. **Other workers are live in `internal/shellintegration`,
  `internal/ssh` (discovery) and `frontend/src/` — keep out of those.**
- Numbers, not adjectives. Heartbeat each phase.

## Read first

`.internal/specs/2026-08-03-port-forwarding-design.md` §7 and §7.3.

## The problem

`nocx-6nh6` built `internal/tunnel` — the model for all three directions plus
the local strategy — and `internal/ssh` grew a `TunnelConn` lease with its own
pooled reference. Nothing at the composition root connects them:
`grep -rn 'internal/tunnel' internal/app internal/transport` returns nothing, so
a user has no way to open a forward.

This epic has paid for that shape twice already — `nocx-ei04` was the same story
for the shell-integration launcher, and `nocx-rtg0` before it shipped an
encrypted store whose write path had no caller while `deadcode` reported empty,
because a reachable read path hid it.

The worker who built it says `RealClient` satisfies the connector **without an
adapter** — verify that rather than assuming it.

## What to build

Wire the local strategy from `internal/app` through a transport option, and
expose opening and stopping a forward as JSON-RPC.

**The wire is a party to the contract** (`AGENTS.md` rule 5): each result shape
gets a schema in `contracts/` with **both** `additionalProperties: false` and an
explicit `required`, the renderer type is **generated** (`npm run contracts`,
never hand-edited), and there is a test that validates **the real result off the
real socket** — not a payload the test built. `internal/transport` already has
`…_OverTheWireConformsToContract` tests; copy one.

Report the **actual** bound address and port, never the requested one: port `0`
means "allocate", and the panel showing `0` would be a lie.

## Prove it

```bash
deadcode -filter 'nocx/internal/tunnel' ./...
```

Empty. Put the output in your report verbatim; if `deadcode` is not installed,
say so rather than skipping quietly.

Then the behavioural proof: open a forward through the **real** transport
against the in-process SSH server `internal/ssh` tests already use, push bytes
through it, and stop it.

## Test first

Red before green, and for every external call a test where it fails
(`AGENTS.md` rule 3): a busy local port, a connector that refuses, a stop for an
id that does not exist, and — the one that matters for §7.3 — closing the tab
that shares the connection must **not** stop another tab's forward.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, the deadcode output verbatim, test counts, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<phase>" --json
```
