# Worker brief — STORE-6 / bead `nocx-208`: ContentDB seam + stub

You are one of three workers running in parallel in the **same checkout**
(`/home/dev/repos/nocx`, branch `feat/persistence-storage-capabilities`). Read these before
writing code:

1. `docs/decisions/0011-persistence-storage-capabilities-and-secret-references.md` — binding,
   **§5 is the heart of your task**.
2. `.internal/plans/2026-07-26-persistence-storage-capabilities.md` — **§Task 6** is your spec,
   verbatim. Also read §"File ownership map".
3. `AGENTS.md` — engineering rules.

## Your deliverable

`internal/content/**`: the `ContentDB` capability, the `ConversationRepository` and
`CommandHistoryRepository` interfaces written against it, and a stub implementation that logs
and returns a sentinel error — exactly the shape `internal/config/config.go`'s `Stub` uses
today (read it as the pattern).

**The SQLite implementation is explicitly NOT part of this task.** `go.mod` and `go.sum` must
come out unchanged; verify with `git diff --stat go.mod go.sum` producing no output, and say so
in your report.

Record the conditions for the real implementation in a package doc comment where the future
implementer will find them — the list is in plan §Task 6 (one `content.db`, WAL, `foreign_keys=ON`,
short transactions through one write path, and the "removed from nocx" not "securely erased"
honesty constraint).

No generic `Repository[T]` — ADR-0011 §1 rejects it explicitly and says why.

## Files you own (nobody else touches them this wave)

- `internal/content/**` (create — the whole package is yours)

## Files owned by OTHER workers — do not touch, escalate instead

- `internal/storage/**`, `internal/app/app.go` → owned by the STORE-1 worker
- `internal/credential/**`, `internal/connection/resolver.go`, `internal/transport/ws.go`,
  `internal/ssh/**`, `internal/profile/profile.go` → owned by the STORE-3 worker

Your package is a declared seam; it does **not** get wired into the composition root in this
task. The coordinator wires it later. Do not edit `internal/app/app.go` to hook it up.

## Ground rules

- **Greenfield.** No migrations, no back-compat shims. No speculative features — YAGNI: declare
  only what ADR-0011 §5 and plan §Task 6 name.
- **TDD**: failing test first, run it, watch it fail, then the minimal implementation.
- **No commit, no push, no branch, no `git stash`.** The coordinator commits.
- **No repo-wide gates.** Do **not** run `go build ./...`, `go test ./...`, `golangci-lint run`.
  Scope your runs: `go test ./internal/content/...`
- **No formatting runs.** No `gofumpt -w`, no `prettier`. Separate final wave.
- **Do not touch the issue tracker.** No `bd` commands — the coordinator owns beads.

## Report in `worker_done`

Numbers, not adjectives:

- Test count and the exact command you ran.
- The interface names and method signatures you declared, so the coordinator can check them
  against ADR-0011 without opening the files.
- The literal output of `git diff --stat go.mod go.sum` (expected: empty).
- **Anything you could not verify, stated explicitly.** Silence here is treated as a failure to
  report, not as "nothing to report".
- Any problem you spotted and deliberately left alone.
