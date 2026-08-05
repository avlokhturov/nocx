# P10 — the footprint is visible and removable (`nocx-bu6q`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first, then N3 and §4.1 of
[`../specs/2026-08-05-nocxify-delivery-modes-design.md`](../specs/2026-08-05-nocxify-delivery-modes-design.md).

## Why this package exists

The owner decided nocx installs on a remote host **without asking** (N3). That is a
deliberate trade, and it is only defensible if the product then tells the truth about it:
a user must be able to see that nocx wrote to a machine, see exactly what and where, and
remove it. AGENTS.md's rule about soft degrades applies in the other direction here — a
footprint that exists only in a log is a footprint the user cannot consent to after the
fact.

## What you build

**A status surface.** For a destination with a committed bundle: the host, the generation,
the absolute path (`~/.nocx`), the protocol and script version, and when it was last
observed. P1's `Publisher.Verify()` is the source; P7's installed fact is what makes the
question answerable without connecting.

**An uninstall action.** It removes only manifest-owned, unmodified files; anything the user
changed is reported as a conflict and left alone; `~/.nocx` is never removed recursively.
`Publisher.Uninstall()` already implements exactly that — you are exposing it, not
reimplementing it.

## Files you own

A new transport handler beside `ws_shell_launcher.go`, its result schemas in `contracts/`
with generated TypeScript and **both** conformance tests, the `app.go` wiring for it, and the
UI surface. Read `frontend/src/ui/README.md` and list `frontend/src/ui/` **before** building
any control: the kit has the component, or it grows a variant — a hand-rolled div with its
own colours is the defect two epics were spent unwinding. A surface may place a kit component
and may never repaint it.

P9 is working in `terminal-content.ts`, `input-state.ts` and `environment-commands.ts` at the
same time — do not touch those.

## What must be true

- for an installed destination the surface names host, generation, path and versions; for one
  with no bundle it says so rather than showing an empty shell.
- uninstall removes only manifest-owned unmodified files; a modified file produces a reported
  conflict and stays; `~/.nocx` is never removed recursively; the result says which files
  went and which did not.
- the schemas carry `additionalProperties: false` plus an explicit `required`, the generated
  TypeScript is committed, `npm run contracts:check` passes, and both conformance tests exist
  — the DTO one and the one that validates the real result off the real socket.
- a destination in mode `raw` never shows an install offer, and `relay` shows its consent
  state honestly rather than pretending.
- the surface is reachable by a user: name in your report the path a person takes to it.

## Verify

`go build ./...`, `go vet` and `golangci-lint run` on the packages you touch,
`go test -race` scoped to them, `cd frontend && ./node_modules/.bin/tsc --noEmit`,
`npm run contracts:check`, and vitest scoped to your files. Nothing repo-wide, no formatting
runs.
