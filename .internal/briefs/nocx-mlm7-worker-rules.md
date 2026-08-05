# nocx-mlm7 — ground rules for every worker in this epic

Read this, then your own package brief in the same directory, then
`.internal/specs/2026-08-05-nocxify-delivery-modes-design.md`. The spec is the contract;
the brief only says which part of it is yours.

## Where you are

`pwd` first. You are in **your own git worktree**, and its absolute path is in your package
brief. Never write to the coordinator's checkout — if a path in any document looks absolute
and is not under your worktree, it is not yours. Files created in the wrong tree are lost
work: they will not be in your diff and nobody will find them.

## What you may not do

- **No commit, no push, no branch.** Leave your work uncommitted in the worktree; the
  coordinator reviews the diff and lands it.
- **No repo-wide gates.** Do not run `go test ./...`, the full `vitest` suite,
  `golangci-lint run` over the repo, `prettier`, `gofumpt` or `eslint`. Other workers are
  editing other files in parallel and you will see their half-written state and report a
  phantom blocker. Verification is scoped to **your own files** (below).
- **No formatting passes.** Formatting is a single final wave run by the coordinator.
- **Do not touch files another worker owns.** Your brief names them. If you believe you
  must cross the boundary, escalate instead — that is a coordinator decision, and it is
  cheap.
- **Do not touch the issue tracker.** `bd` is the coordinator's. The beads database is not
  even in your worktree, so `bd show <id>` will find nothing; everything you need is in
  these files.

## What you must do

- **TDD.** Red, then green. This repo's rule 1: a test asserts what a user can do, not what
  the code currently does. Where the spec states an assertion, that assertion is the test.
- **Type-check your own files even though repo-wide gates are banned.** Test runners that
  transpile (vitest) do **not** type-check, so a green suite can sit on a file that does not
  compile. Use `cd frontend && ./node_modules/.bin/tsc --noEmit` for TypeScript and
  `go build ./...` plus `go vet ./<your package>` for Go. The type-checker sees the whole
  project, so you may see errors in files you do not own: **report those, do not fix them.**
  Errors in your own files are blocking.
- **Targeted tests only:** `go test -race ./internal/<your package>/...` or
  `cd frontend && ./node_modules/.bin/vitest run src/<your files>`.
- **Heartbeat at every phase change**, using the ids from the dispatch preamble you were
  given:
  ```
  orca orchestration send --run <run> --to <coordinator> --type heartbeat \
    --subject alive --task-id <taskId> --dispatch-id <dispatchId> --phase "<what you are doing>" --json
  ```
  Without it there is no way to tell slow from dead, and an exited pane loses its scrollback.
- **One `worker_done` when finished**, with numbers rather than adjectives: tests added and
  passing, what you could not verify and why, and every problem you noticed and deliberately
  left alone. Silence about what you could not verify is treated as a false report.
- **Escalate rather than guess** when the spec is ambiguous:
  `orca orchestration escalate` / `ask` per your preamble. A blocked worker that asks costs
  minutes; a worker that guesses costs the wave.

## Context you will want

- `AGENTS.md` — the repo's operating contract. The five testing rules are not decoration.
- `docs/architecture.md` — AD-1 (one WebSocket: binary data plane, JSON-RPC control plane),
  AD-6 (the backend never sniffs the byte stream; the renderer parses), AD-8 (one owner per
  behaviour, variation lives in adapters).
- `contracts/README.md` — if you touch a JSON-RPC **result** shape, its schema, the
  generated TypeScript, and both conformance tests (`…_DTOConformsToContract` and
  `…_OverTheWireConformsToContract`) land in the same change. `additionalProperties: false`
  plus explicit `required`, or it is theatre.
- The current gate baseline on this branch is **green**: `gofumpt`, `golangci-lint`,
  `go test -race ./...`, prettier, eslint, typecheck and `npm test` all pass at
  `HEAD`. Anything you find red in your own files, you caused.
