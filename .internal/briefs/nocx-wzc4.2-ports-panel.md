# Brief — nocx-wzc4.2: the ports panel

Supervised worker. Read this whole file first.

## Ground rules

- **No commit, no push, no branch.** **Do not touch `bd`.**
- **No repo-wide gates.** **Do run** `go build ./...`, `go vet` and
  `golangci-lint run` scoped to what you touch; from `frontend/`:
  `./node_modules/.bin/tsc --noEmit`, `npx eslint src/`,
  `npx prettier --check src/`, `npm run contracts:check`, and
  `npm test -- --run` for the files you touched. The type-check is not optional —
  vitest transpiles without type-checking, so a green suite can sit on a file
  that does not compile.
- You own the ports/tunnels surface in `frontend/src`, a new
  `internal/transport/ws_ports.go`, and the discovery wiring in
  `internal/app/app.go`. **Another worker is adding a `shell.integrate` dispatch
  case in `ws.go` and a palette item in `main.tsx`** — keep your edits in those
  two files minimal and say so in your report. **A third worker owns
  `internal/tunnel` and `internal/ssh/ssh_tunnel.go` — stay out; `tunnel.open`
  and `tunnel.stop` already exist and are what you call.**
- Numbers, not adjectives. Heartbeat each phase.

## Read first

`.internal/specs/2026-08-03-port-forwarding-design.md` §5, §6 and §8, and
`frontend/src/ui/README.md` before you build a single control. This brief does
not repeat either.

## The gap

`internal/discovery` (merged, 41 tests) has **no caller outside its own tests**.
That is the exact shape `AGENTS.md` rule 2 names: a package that exists, is
tested, and is not a feature. The read path is what makes it one.

## Cadence: discovery is a background poll, and background polls become bugs

The timers are yours to build and each exists for a reason:

- **Settle sample** after a connection comes up — services take a moment to bind,
  and a panel that samples instantly shows an empty host.
- **Prompt debounce** — a command just finished, so this is when the listener set
  most likely changed. Debounce it; a user hammering `<Enter>` must not queue
  probes.
- **Hidden tab pauses.** A background tab running `ss` on a loop every few
  seconds against a production host is a defect, not a feature.
- **One in flight.** The detector already enforces this; do not build a second
  scheduler that defeats it.

## Render the states as facts, not as blanks

`internal/discovery` returns five result states and three-valued process
evidence, and the whole point was that the user learns _why_:

- `permission-denied` on the process column is **"run as root to see owners"**,
  not an empty cell. Measured on this machine: non-root `ss` named 3 of 9
  listeners. Six blank rows read as a bug in nocx.
- `unsupported` is "this probe cannot tell you" — a different sentence.
- `available-limited`, `unavailable`, `failed-transiently` and
  `permission-or-policy-refused` must be distinguishable. A host with no probe at
  all says so; an empty list means "nothing is listening" and must only appear
  when that is true.

`AGENTS.md`: a soft degrade must be visible in the product, not only in a log.

## The panel

Three sections — **Detected**, **Forwarded**, **Stopped**. Forwarding a detected
port is **one action from the row**; that is the thing Orca's panel gets right
and Tabby's dialog does not. A stopped forward says why it stopped and offers the
retry when retry is meaningful.

The ledger labels a forward, it never claims causation (spec D6). "Appeared while
`npm run dev` was running" is true; "opened by `npm run dev`" is not, and we
cannot know it.

**Read `frontend/src/ui/README.md` and list `frontend/src/ui/` before building
any control.** A status message is `showToast`; a titled group is `Section`. A
surface may place a kit component and may never repaint it. Two epics were spent
unwinding hand-rolled controls inside surfaces; do not open a third.

## Contract

The new result shape gets a JSON Schema in `contracts/`, the renderer type is
generated from it, and the conformance test that matters validates the result
**off the real socket** — not a payload the test built (`AGENTS.md` rule 5).
`additionalProperties: false` plus an explicit `required`, or it is theatre.
Watch for a slice marshalling as `null` rather than `[]`; the schema's first run
in this repo caught exactly that.

## Prove it

```bash
deadcode -filter 'nocx/internal/discovery' ./...
```

Empty, and the output goes in your report verbatim. If `deadcode` is not
installed, say so rather than skipping quietly.

## Test first

Red before green. Assert what a user can do, not what the code renders
(`AGENTS.md` rule 1): the panel is reachable from the state a user starts in,
the forward action on a detected row reaches the client method, and the row moves
to Forwarded afterwards. Plus: a hidden tab stops sampling; a permission-denied
probe renders the explanation; a probe-less host says so.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, the deadcode output verbatim, test counts before/after, which kit components you used or added, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<phase>" --json
```
