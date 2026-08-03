# Brief — nocx-ei04: the launcher must be reachable from `main()`

You are a supervised worker. Read this whole file before touching anything.

## Ground rules

- **Do not commit, push, or create a branch.** The coordinator integrates.
- **Do not touch `bd`.** Beads lives in a Dolt database git does not carry.
- **Do not run repo-wide gates** (no `go test ./...`). **Do run**
  `go build ./...`, `go vet` and `golangci-lint run` **scoped to the packages
  you touch**. golangci-lint is not optional: two earlier waves in this epic
  shipped findings because their briefs forgot to name it.
- You own `internal/app/app.go`, `internal/transport/ws.go`, and — only if the
  seam genuinely needs it — `internal/session/session.go`. No other worker is
  live; the whole branch is yours.
- Report **numbers, not adjectives**.
- Heartbeat at every phase change (bottom of this file).

## Baseline

`go build ./...` clean, `golangci-lint run ./...` clean, and
`go test ./internal/{ssh,session,shellintegration,profile}/...` green — measured
just now on the commit this worktree was cut from. `shellintegration` takes ~10s
because it drives real shells.

## The problem

This epic built a launcher and a consumer and never connected them.

- `internal/shellintegration/launcher.go` exposes `NewRemoteLauncher()`.
- `internal/ssh/ssh.go` consumes a `RemoteLauncher` interface, and
  `ssh_real.go` calls it in `shellStartCommand`.
- `grep -rn RemoteLauncher internal/app internal/transport` returns **nothing**.

So the launcher is reachable from its tests and from nowhere else. That is
`AGENTS.md` check 5 verbatim, and the epic it names as precedent — `nocx-rtg0` —
shipped an entire encrypted store whose write path had no caller while
`deadcode` reported empty, because a reachable read path hid it. Do not let this
be the same story.

## The seam, and why it needs an adapter

`internal/ssh` declares **its own** `ShellKind`, `RefusalReason`,
`LaunchOptions` and `RemoteLauncher`, following the `RemoteInstaller` precedent
of declaring the interface at the consumer. `internal/shellintegration` declares
its own set with the same names. Go interface satisfaction needs *identical*
named types, so `shellintegration.NewRemoteLauncher()` does **not** satisfy
`ssh.RemoteLauncher`.

**Write a small adapter at the composition root.** That is where wiring belongs
(`AGENTS.md`: every module behind an interface, wired at one composition root),
and it keeps `ReasonRemoteCommand` in the ssh layer where it is *discovered* —
from `ssh_config` — rather than pushing an ssh-config concern into the
launcher's vocabulary. Do **not** "fix" this by making one package import the
other's types; that was considered and rejected.

Map every `shellintegration.RefusalReason` to its `ssh` counterpart explicitly,
and make an unmapped value fail loudly rather than silently becoming
`ReasonNone` — a reason that degrades to "no refusal" is how a soft degrade
becomes invisible.

## The plumbing

`cfg.RemoteLauncher` is a field on `ssh.ConnectConfig`, which
`internal/transport/ws.go:982` builds. So the chain is
`app.go` → a transport option → `ConnectConfig`. Follow the shape of the
options already there — `transport.WithProber`, `WithProfileService`,
`WithSSHConfigResolver` are all wired from `app.go` the same way.

`internal/app/app.go:139` already constructs `shellintegration.New(logger)`;
your launcher is constructed alongside it.

## The reason has to reach the product

`internal/session/session.go` already exposes `ShellIntegrationReason()`. A
reason that only reaches a log is the failure `AGENTS.md` names — "a soft
degrade must be visible in the product, not only in a log". Carry it out over
JSON-RPC so the renderer can eventually show it.

**The wire is a party to the contract** (`AGENTS.md` rule 5, `contracts/README.md`):
the result shape you add or extend gets a JSON Schema in `contracts/` with both
`additionalProperties: false` and an explicit `required`, the renderer's type is
**generated** (`cd frontend && npm run contracts`, never hand-edited), and there
is a test that validates **the real result off the real socket** — not a payload
the test built. `internal/transport` already has `…_OverTheWireConformsToContract`
tests; follow one.

You do **not** have to render anything in the UI. You have to make the reason
reachable and contractually declared.

## Prove it, do not assert it

```bash
deadcode -filter 'nocx/internal/shellintegration' ./...
```

`NewRemoteLauncher` must not appear as unreachable. Put the actual output in
your completion message. If `deadcode` is not installed, say so rather than
skipping the check quietly.

Then the behavioural proof, which matters more: a test that opens an SSH session
through the **real** transport path and observes that the launcher's start
command is what the session runs. `cmd/devharness` runs the real backend
headless if you need it.

## Test first

Red before green. For every external call there is a test where it fails
(`AGENTS.md` rule 3): the adapter with a launcher that declines, one that
returns an unmapped reason, and a transport with no launcher wired at all —
each leaving a usable session.

## When you are done

```bash
orca orchestration send --type worker_done --subject "<one-line status>" \
  --body "<what changed, the deadcode output verbatim, test counts before/after, anything you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
```

`--outcome failed` if you did not finish.

```bash
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<reading|red|green|verifying>" --json
```
