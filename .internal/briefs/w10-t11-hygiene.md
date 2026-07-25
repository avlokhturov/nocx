# W10 — hygiene: whitespace, gofumpt, dead UI fields (bead nocx-1q2, PR11-T11)

Worker in an Orca wave. The coordinator owns the branch, the commits and the issue
tracker. Work in `/home/dev/orca/workspaces/nocx/pr-11-boundary`.

**Run `bd show nocx-1q2` first.**

## Why

This bead is evidence that the commit gate never ran on the original PR #11 branch. Each
item is small; together they are the fingerprint of work that bypassed the hook.

Note one item is already done: `frontend/src/tabs.ts.orig`, the committed 44 KB conflict
artifact, was deleted by the coordinator in `e5ad9f2`. Do not go looking for it.

## The work

1. **`gofumpt`** — `internal/profile/profile.go` is flagged. Run `gofumpt -l .` and fix
   whatever it reports.
2. **Trailing whitespace** — `git diff --check` reports extensive trailing whitespace
   starting at `frontend/src/connections.ts:71`. Clear it. `git diff --check` against the
   merge base is the check that matters, not a visual scan.
3. **Dead UI fields** — `connections.ts` makes keepalive interval, ready-timeout and
   agent-forwarding editable in the form. Establish for each whether anything consumes it:
   does the value reach the backend, and does the backend act on it?

   **This is the part that needs judgement, not deletion reflex.** Three outcomes are
   possible per field and they are not interchangeable:

   - the field is wired end to end → leave it alone;
   - the field is collected and silently dropped → it is a lie to the user, who sets a
     keepalive that never happens. Remove the control, or report it if removing it means
     touching a file you do not own;
   - the field is collected, sent, and the backend ignores it → that is a missing feature,
     not dead UI. **Do not delete it.** Report it so it can be filed.

   Say which of the three each field is, and on what evidence — the call site that consumes
   it, or the absence of one.

## Boundaries

You own `frontend/src/connections.ts`, `internal/profile/profile.go`, and whatever else
`gofumpt -l .` and `git diff --check` name — those two commands define your scope, so run
them first and report what they list before changing anything.

Another worker is active on `nocx-l7o` (the `Secret` type) in `internal/credential/**`,
`internal/ssh/ssh_auth.go`, `internal/connection/**` and `internal/transport/**`. Do not
touch those. If `gofumpt` flags a file in that set, report it and leave it — the coordinator
will fold it in at the phase gate.

Do not reformat files for the sake of it. A whitespace-only diff across the repo would bury
the other worker's change in review noise and make the next `git diff origin/main...HEAD`
sweep useless.

## Verification

- `gofumpt -l .` reports nothing in your scope
- `git diff --check` is clean
- `cd frontend && npx tsc --noEmit && npm run lint && npm run format:check && npx vitest run`
- Do NOT run `go test ./...` — it compiles the other worker's half-written packages and
  would report a phantom blocker. `go build ./internal/profile/...` is enough for your part.

## Ground rules

- No commits, no pushes, no branches. No `git stash`.
- Do not touch beads / `bd`.
- Before reporting done: `git diff HEAD | grep '^-'` and read it. A hygiene task is exactly
  where an accidental deletion hides, because the diff is expected to be full of removals.
- Report numbers, not adjectives: files formatted, whitespace lines cleared, and the verdict
  per UI field with its evidence.
- State plainly anything you could not verify.

## When done

Write `.internal/reports/t11-hygiene.md`, then `worker_done` from your own terminal with the
`taskId`/`dispatchId` from the dispatch preamble.
