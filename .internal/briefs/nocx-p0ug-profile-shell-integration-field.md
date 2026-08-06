# Brief — nocx-p0ug: a connection decides its own shell integration

You are a supervised worker. Read this whole file before touching anything.

## Ground rules

- **Do not commit, push, or create a branch.** The coordinator integrates.
- **Do not touch the issue tracker (`bd`).** Beads lives in a local Dolt database
  git does not carry — `bd show` finds nothing here. Everything is below.
- **Do not run repo-wide gates** — no `go test ./...`, no repo-wide lint, no
  formatting sweep. Formatting is a final single-worker wave.
- **Do run** `go build ./...`, `go vet ./internal/profile/...`, and — because you
  touch generated frontend types — `cd frontend && ./node_modules/.bin/tsc
--noEmit`. The type-check is **not** a repo-wide gate for these purposes and is
  not optional: vitest transpiles without type-checking, so a suite can be green
  while your file does not compile. An error in a file you do not own: **report
  it, do not fix it**.
- You own `internal/profile/` (and its tests), one new file under `contracts/`,
  and the generated frontend type file that `npm run contracts` rewrites. Other
  workers are in `internal/ssh/` and `internal/shellintegration/` in separate
  worktrees — do not touch those.
- Report **numbers, not adjectives**.
- Heartbeat at every phase change (see the end).

## Baseline

`go test ./internal/profile/...` passes on the commit this worktree was cut from
— measured, 0.3s.

## Context

Read `.internal/specs/2026-08-03-nocxify-design.md` §5.1 — tracked, in this
worktree. Short version: nocx is growing shell integration for SSH sessions, and
"should this connection be integrated automatically, only on request, or never?"
must be a property of the connection rather than a guess. This task adds and
persists that field. It does not yet _do_ anything — the launcher that consumes
it is a later task. Persisting and resolving it correctly is the whole job.

## What to build

A field `shellIntegration` with values `auto | ask | off`, resolved through the
option cascade that already exists:

> hardcoded default → global setting → ancestor group defaults → nearest group
> → the profile itself

`auto` is the default.

## The method: copy an existing field exactly

**This is the important instruction.** The cascade's containers exist, but a new
field is not free — it must be threaded through the dense option type, the stored
type, the sparse/patch type, the allowlist, the conversion functions both ways,
the layer merge, the provenance map, the patch-path table and the effective-view
builder. Each is a place a field gets silently dropped, and a dropped field looks
exactly like a working one until someone's setting stops sticking.

So do not reason about which sites are needed. Enumerate them:

```bash
grep -n "agentForward\|AgentForward" internal/profile/profile.go
```

That returns every site a boolean option occupies — the structural template.
Handle `shellIntegration` at **every one of them**. When you are done, the same
grep for your field must return a comparable set of sites, and you should say so
in your completion message with both counts.

`agentForward` is a `bool`; yours is an enum. For the enum half — a named string
type, its validation, and how an invalid stored value is treated — follow `Auth` /
`AuthMode` in the same file, which is already exactly that shape.

Decide deliberately and write down in a comment: what happens when a stored
profile carries a `shellIntegration` value this build does not recognise. Falling
back to the default is defensible; silently treating it as `off` is not, because
a user's explicit choice would become a silent no-op.

## The wire is a party to the contract

`AGENTS.md` rule 5: every JSON-RPC result shape is declared once as a JSON Schema
in `contracts/`, the renderer's types are **generated** from it and committed, and
the Go side is validated against it. Read `contracts/README.md`.

- Add or extend the schema covering the profile shape you changed. It needs both
  `additionalProperties: false` and an explicit `required` — a schema with neither
  is theatre.
- Regenerate and commit the generated frontend type:
  `cd frontend && npm run contracts`, then `npm run contracts:check` must pass.
  Never hand-edit the generated file.

## Test first

Red before green. Write the acceptance as a **table-driven precedence test**
before the implementation: for each layer, a fixture that sets the field only at
that layer resolves to it, and a lower layer setting it too does not win. Include
an explicit `off` at the profile over an `auto` at the group — that is the case a
user will actually rely on and the one a partial implementation gets wrong.

Also assert the provenance map: the effective view must report **which layer** the
value came from, not only the value.

## When you are done

```bash
orca orchestration send --type worker_done --subject "<one-line status>" \
  --body "<what changed, the two grep site counts, test counts before/after, anything you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "internal/profile/profile.go,contracts/<file>,<generated type>,<test files>" --json
```

`--outcome failed` if you did not finish. Never encode failure only in prose.

```bash
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<reading|red|green|verifying>" --json
```

`TASK_ID` and `DISPATCH_ID` are in the message that pointed you here.
