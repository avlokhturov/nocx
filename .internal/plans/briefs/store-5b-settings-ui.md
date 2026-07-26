# Worker brief — STORE-5b / bead `nocx-9m5`: the generated settings screen (frontend half)

Repo `/home/dev/repos/nocx`, branch `feat/persistence-storage-capabilities`. **Two other
workers are live**, both entirely in Go: one in `internal/profile|connection|importer|transport|app`,
one in `internal/settings`. **You are the only worker in `frontend/`.** Read before writing code:

1. `.internal/plans/settings-rpc-contract.md` — **frozen, and it is your whole backend
   contract**. The Go side that serves it is being built right now by another worker and is not
   reachable from your machine yet, so you build and test against the contract, not against a
   live server. Escalate rather than change it: two other workers built against it too.
2. `docs/decisions/0011-persistence-storage-capabilities-and-secret-references.md` — §2 and §3.
3. `AGENTS.md` — engineering rules.

## Your deliverable

A settings screen that is **generated from `settings.describe`**, plus its RPC client methods
and unit tests. There is no settings UI in the app today, so this is a new surface.

The load-bearing acceptance criterion from bead `nocx-9m5`: **the screen is rendered from
declarations, not hand-maintained.** Concretely — if the backend adds a declaration, the screen
must show a working control for it with no frontend change at all. A hardcoded list of settings,
a `switch` over known keys, or a per-setting component registry keyed by literal key names all
fail this bar. Render by `control` kind, group by `section`, and treat the key as data.

Follow the patterns already in the codebase rather than inventing new ones:

- `frontend/src/profiles.ts` holds the RPC client class with its private `call(method, params)`
  helper and one thin method per RPC. Add the settings methods in the same style.
- `frontend/src/connections.ts` is the closest existing example of a screen module; mirror its
  structure, its DOM construction approach and its test style.
- `frontend/src/*.test.ts` shows the vitest conventions used here. Every module gets tests.

### The secret control is the part to get right

A `control: 'secret'` declaration must render as **"configured" / "not configured"** — driven by
`settings.secretExists` — with **Replace** and **Clear** actions. It must **never** render a
populated input, because there is no API that returns the value and there deliberately never
will be (ADR-0011 §2). `settings.getAll` does not include secret keys at all, so your renderer
must not assume every declaration has an entry there.

Write a test that asserts this: a secret-class declaration produces no element whose value
contains secret material, and the client exposes no method that could fetch one.

### Validation and errors

`settings.set` reports a validation failure as a JSON-RPC **error**, not `ok: false`. Surface it
against the offending control rather than as a bare toast, and cover it with a test.

## Files you own (nobody else touches them this wave)

- `frontend/**` — all of it, including `frontend/src/profiles.ts` if you extend the client there

## Files owned by OTHER workers — do not touch, escalate instead

- Everything under `internal/` is Go and belongs to the two backend workers. You should not need
  to open any of it; the frozen contract is your interface.

## Ground rules

- **Greenfield.** No migrations, no back-compat shims, no feature flags for "old settings".
- **TDD**: failing test first, run it, watch it fail, then the minimal implementation.
- **No commit, no push, no branch, no `git stash`.** The coordinator commits.
- **No repo-wide gates and no Go commands at all.** Do **not** run `go build`, `go test`,
  `golangci-lint`, or the Playwright/e2e suite. Scope your runs to the frontend unit tests:
  `cd frontend && npx vitest run src/<your-files>`
  Note `nocx-bw2` records that 13 e2e tests already fail on `main` — that suite is a known-red
  baseline and is not your concern.
- **No formatting runs.** No `prettier --write`, no `gofumpt`. The coordinator does a final sweep.
- **Do not touch the issue tracker.** No `bd` commands.

## Report in `worker_done`

Numbers, not adjectives:

- How the screen stays generic — name the mechanism that lets a brand-new declaration render
  with zero frontend change, and say what would break it.
- The client methods you added and the file they live in.
- How you tested the secret control, quoting the assertion.
- Test count and the exact command.
- **Anything you could not verify, stated explicitly** — in particular, say plainly that you
  could not exercise this against a running backend, and name what that leaves unproven.
- Any problem you spotted and deliberately left alone.
