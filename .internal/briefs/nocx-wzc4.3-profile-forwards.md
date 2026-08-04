# Brief — nocx-wzc4.3: forwards you set up once, on the connection

Supervised worker. Read this whole file first.

## Ground rules

- **No commit, no push, no branch.** **Do not touch `bd`.**
- **No repo-wide gates.** **Do run** `go build ./...`, `go vet` and
  `golangci-lint run` scoped to what you touch; from `frontend/`:
  `./node_modules/.bin/tsc --noEmit`, `npx eslint src/`,
  `npx prettier --check src/`, `npm run contracts:check`, and
  `npm test -- --run` for the files you touched. `gofumpt -l .` too — `gofmt` is
  not enough here and two waves have been fixed at the merge gate for it.
- You own `internal/profile/`, the connection editor in `frontend/src`, and the
  connect-time hook wherever it lives. **Three workers are live: one in
  `internal/shellintegration` + `internal/transport` + `main.tsx`, one in
  `internal/tunnel` + `internal/ssh/ssh_tunnel.go` + new `internal/ssh` test
  files, one in `internal/ssh/ssh_real.go` + `internal/shellintegration/launcher*`.
  Stay out of all of those.** `frontend/src/ports.tsx` is merged and is not yours
  either; you may read it.
- Numbers, not adjectives. Heartbeat each phase.

## Read first

`.internal/specs/2026-08-03-port-forwarding-design.md` §4, decisions **D3** and
**D5**. This brief does not repeat them.

## What to build

Two things a profile carries.

**A list of forwards opened when the connection comes up.** All three directions;
the tunnel model already carries them and `tunnel.open` already exists — you are
storing intent and replaying it, not reimplementing forwarding.

**The `portDiscovery` field (`auto|ask|off`)**, resolved through the same cascade
as `agentForward` and `shellIntegration`. `nocx-p0ug` threaded
`shellIntegration` through 21 call sites and is the worked example — read that
commit before designing your own path. An unrecognised stored value falls back to
`auto` at resolution, with provenance `default`, exactly as that one does.

## The failure modes that decide whether this is any good

**A stored forward that fails must not fail the connection.** The user is opening
a shell; a busy local port is a fact about their laptop, not a reason to refuse
them a terminal. Report it against the row, keep the session, and open the other
forwards.

**One failing forward must not stop the others.** Same shape as the `nocx-6nh6`
rule about one stream not killing a listener, one level up.

**A forward that is refused by policy says so.** The `-R` strategy produces
policy-worded reasons; carry them through rather than flattening to "failed".

## Test first

Red before green (`AGENTS.md` rule 3 — for every external call, a test where it
fails). Assert: a profile with two stored forwards opens both on connect; a busy
local port reports against its row and leaves the session usable; one failure
does not prevent the other; `portDiscovery` resolves with provenance and an
unrecognised value falls back to `auto`.

And rule 1: the forward list must be **editable from the connection editor by a
person**. Assert the path a user actually takes — the control exists, it is
enabled from the state they start in, and what they save comes back. A test that
mounts the component and asserts what it rendered cannot tell you the feature is
missing; that is precisely how the connection manager shipped with no way to
create a group.

## Before you build a control: read the kit

`frontend/src/ui/README.md` and list `frontend/src/ui/`. A repeating editable row
list is the kind of thing that gets hand-rolled inside a surface — do not. If the
kit lacks it, add it to `ui/` with its CSS file, identity class, test and README
row. A surface may place a kit component and may never repaint it.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, test counts before/after, which kit components you used or added, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<phase>" --json
```
