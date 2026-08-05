# Brief — nocx-axpz: the adapter must degrade, not crash

Supervised worker. Read this whole file first.

## Ground rules

- **No commit, no push, no branch.** **Do not touch `bd`.**
- **No repo-wide gates.** **Do run** `go build ./...`, `go vet` and
  `golangci-lint run` scoped to the packages you touch; plus, if you change a
  contract, `cd frontend && npm run contracts:check` and
  `./node_modules/.bin/tsc --noEmit`.
- You own `internal/app/` and, minimally, `internal/ssh/ssh.go` for the reason
  vocabulary. **Other workers are live in `internal/shellintegration`,
  `internal/tunnel` and `frontend/src/suggest` — stay out.**
- Numbers, not adjectives. Heartbeat each phase.

## Baseline

`go test ./internal/app/... ./internal/ssh/...` green, ~1.5s and ~1.4s.

## The problem

`internal/app/app.go`'s `remoteLauncherAdapter` panics twice: on a refusal
reason it cannot map, and on a launcher that returns `ok=true` while naming a
reason.

**The reasoning behind it is sound and must be preserved.** A decline that
silently becomes `ssh.ReasonNone` renders in the product as "integration
succeeded" — the invisible soft degrade `AGENTS.md` forbids. The author refused
that and chose to fail loudly. Do not undo that half.

**But loud here is a panic in the composition root of a terminal backend**, and
ADR-0004:60 makes fail-open an invariant of the very epic this code belongs to:
no failure path may leave the user without a working terminal. A crash is the
most extreme violation of that available. Two correct instincts collide, and the
collision is currently resolved in favour of the one the ADR rules against.

**Not urgent, and know why:** the switch is exhaustive over the three declared
reasons, so the default arm is unreachable today. It goes live the moment
somebody adds a reason to one package and not the other — which is exactly what
the tripwire exists to catch, and exactly when a user would lose their terminal
to it.

## What to build

The middle path, where neither instinct loses: a **distinct** reason value —
`unknown`, or whatever you can defend — that is visible in the product, plus a
loud log. That is *not* the silent `ReasonNone` fallback that was correctly
rejected; it says "integration did not happen and I cannot tell you why", which
is true and useful, rather than "integration succeeded", which is false.

The same applies to the accept-with-reason case: a launcher contradicting itself
is a bug worth shouting about, and shouting must not mean killing the session.

The reason travels over the wire (`contracts/open.schema.json`) — if you add a
value, the schema enum, the generated renderer type and the conformance test
move with it. `AGENTS.md` rule 5.

**Alternatively**, if after reading ADR-0004 you conclude the panic is right,
say so and propose the ADR amendment instead — that is a legitimate outcome, but
it must be argued, not assumed, and the code and the ADR must end up agreeing.

## Test first

Red before green. Assert that an unmapped reason and an accept-with-reason each
leave the session **usable**, surface a distinct reason rather than
`ReasonNone`, and do not panic. `AGENTS.md` rule 3: for every external call
there is a test where it fails.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, which path you chose and why, test counts, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<phase>" --json
```
