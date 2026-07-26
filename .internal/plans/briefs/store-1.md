# Worker brief — STORE-1 / bead `nocx-2j3`: shared storage path resolution

You are one of three workers running in parallel in the **same checkout**
(`/home/dev/repos/nocx`, branch `feat/persistence-storage-capabilities`). Read these before
writing code:

1. `docs/decisions/0011-persistence-storage-capabilities-and-secret-references.md` — binding.
2. `.internal/plans/2026-07-26-persistence-storage-capabilities.md` — **§Task 1** is your spec,
   verbatim. Also read §"What already landed" and §"File ownership map".
3. `AGENTS.md` — engineering rules.

## Your deliverable

`internal/storage/paths.go` + tests, and the composition-root rewrite in
`internal/app/app.go`. Exact interface, platform rules, acceptance criteria and TDD steps are
in plan §Task 1. Do not invent a different interface shape.

## Files you own (nobody else touches them this wave)

- `internal/storage/paths.go`, `internal/storage/paths_test.go` (create)
- `internal/app/app.go` (modify lines 76-85 — the `os.UserConfigDir()` block and the
  `os.TempDir()` fallback), `internal/app/app_test.go` (adjust if it asserts on `New()`)

## Files owned by OTHER workers — do not touch, escalate instead

- `internal/credential/**`, `internal/connection/resolver.go`, `internal/transport/ws.go`,
  `internal/ssh/**`, `internal/profile/profile.go` → owned by the STORE-3 worker
- `internal/content/**` → owned by the STORE-6 worker

If your change appears to need one of those files, **escalate** rather than editing it.

## Ground rules

- **Greenfield.** No migrations, no back-compat shims, no compatibility fallbacks. Delete the
  old path rather than bridging it. Breaking existing on-disk state is expected.
- **TDD**: failing test first, run it, watch it fail, then the minimal implementation.
- **No commit, no push, no branch, no `git stash`.** The coordinator commits.
- **No repo-wide gates.** Do **not** run `go build ./...`, `go test ./...`, `golangci-lint run`,
  or any full-project check — another worker's half-written file will make you report a
  phantom blocker. Scope every run to your own packages:
  `go test ./internal/storage/... ./internal/app/...`
- **No formatting runs.** No `gofumpt -w`, no `prettier`. Formatting is a separate final wave.
- **Do not touch the issue tracker.** No `bd` commands at all — the coordinator owns beads.

## Report in `worker_done`

Numbers, not adjectives:

- Test counts before and after, and the exact command you ran.
- The paths your implementation resolves on this machine (all three roles).
- Confirmation that the `os.TempDir()` branch and the `configDir == ""` branch are **gone**,
  not merely unreachable.
- **Anything you could not verify, stated explicitly.** Silence here is treated as a failure
  to report, not as "nothing to report".
- Any problem you spotted and deliberately left alone.
