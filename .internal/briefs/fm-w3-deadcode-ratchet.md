# W3 — the dead-code ratchet: old violations warn, new ones fail

## Where you are

You are in your OWN git worktree. **Run `pwd` first and use that path for everything.**
Never write to `/home/dev/orca/workspaces/nocx/feat-file-manager-2` — that is the
coordinator's checkout.

The issue tracker is NOT in your worktree; `bd` will find nothing. Everything is in this brief.

## The problem, stated exactly

This repository has three different questions about code nobody uses, and it currently asks
only two of them:

| Question                               | Who asks it                              | What it misses                            |
| -------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| "is this symbol referenced anywhere?"  | `unused` in `.golangci.yml`, eslint      | a symbol referenced only by its own tests |
| "is this reachable from `main()`?"     | `deadcode` — **not wired into any gate** | anything in TypeScript                    |
| **"does anybody READ what we write?"** | **nobody**                               | this is the gap                           |

The third one is not hypothetical. `restoreDescriptor` is written in four places —
`frontend/src/tabs.ts:456`, `tabs.ts:504`, `main.tsx:226`, `state/tab-model.ts:255` — declared
`readonly restoreDescriptor: unknown` in two, and **read nowhere**. The full gate is green.

**You are not fixing that.** You are building the gate. The cleanup is a separate task.

## The owner's rule, which shapes everything

> **Existing violations are warnings. New violations are forbidden.**

That is what makes this finishable. There are 86 unreachable Go functions today; a gate that
fails on all 86 gets disabled by the first person it blocks. So: a **committed baseline**, and
the gate fails only on a violation that is not in it. Removing a baseline entry must never fail
— the baseline shrinks freely, and its growth is visible in review because it is a committed
file.

## Follow the mechanism this repo already has. Do not invent a second one.

`frontend/lint-fixtures/` is already exactly this pattern, and it is the answer you must extend
rather than duplicate:

- `check-css-colors.mjs`, `check-kit-identities.mjs`, `check-css-integrity.mjs` — checkers that
  emit violations
- `color-literals-baseline.json`, `raw-controls-baseline.json`, `inline-markup-baseline.json` —
  committed baselines
- `update-color-literals-baseline.mjs`, `update-raw-controls-baseline.mjs`,
  `update-inline-markup-baseline.mjs` — the regeneration scripts
- `gate.sh` and the `lint` script in `frontend/package.json` — how they are run

Read those first and match their shape, their output format, their exit-code convention and
their naming. A fourth baseline that behaves differently from the existing three is worse than
no baseline.

## What you own

- `frontend/lint-fixtures/check-dead-exports.mjs` (or whatever name matches the existing
  convention) and its baseline + update script
- `frontend/knip.json`
- a Go-side checker + baseline + update script, placed wherever the Go gates live — read
  `.githooks/pre-commit` and follow it
- the wiring in `.githooks/pre-commit` and/or `frontend/package.json`
- `frontend/package.json` only for the script entries and, if unavoidable, a devDependency

Nothing else. Do not touch `internal/**`, `frontend/src/**`, or `contracts/**` — other workers
are writing there right now and their files are half-finished by design.

## Build it

### Go half

`deadcode` (`golang.org/x/tools/cmd/deadcode`) answers "reachable from main()". Measured on this
branch today: **86 unreachable funcs excluding `node_modules`**, up from 66 recorded eleven days
ago. That growth is the argument for the ratchet, and it is also your regression test.

Baseline it, wire the check into `.githooks/pre-commit` next to the existing Go gates, and make
it report the delta rather than the total: how many are baselined, how many are new, and name
the new ones.

### TypeScript half

`knip` answers "does this export have a consumer?". **It is currently unconfigured, and its raw
numbers are not trustworthy** — run zero-config it reports 118 unused exports, 127 unused
exported types and 35 unused files, and emits a configuration hint saying it does not know the
entry points. An export consumed only by a file knip wrongly believes is unused is itself
counted unused, so those numbers are inflated by an unknown amount.

**Your first job on this half is `knip.json` with the real entry points**, and the first honest
number comes after that. Report the before and after. Do not put the zero-config numbers in any
committed file as though they were measurements.

### What neither half catches — say so in the code

Neither `deadcode` nor `knip` would have caught `restoreDescriptor`: `deadcode` asks about
reachability and every writer of it is reachable; `knip` asks about exports and it is a member of
one, not an export. **Write that limitation into the checker's header comment**, so the next
person does not read a green gate as proof that no dead paths exist. The gate is a floor. The
criterion stays what `AGENTS.md` already says: every epic proves its happy path end to end.

## Verify

- Both checkers exit 0 on the current tree with the baselines you generate.
- Both **fail** when you introduce a deliberate new violation — prove this, do not assert it.
  Add the violation, show the failure, remove it. Report the exact output.
- Removing an entry from a baseline exits 0.
- The pre-commit hook still runs end to end and does not become materially slower. State the
  measured before/after wall time, because a gate that adds thirty seconds to every commit will
  be bypassed with `--no-verify` and then it protects nothing.

Do **not** run repo-wide `go test ./...` or the full frontend suite — other workers have
in-flight files here and their errors are not yours. Your gates are the exception, because
running them IS your task.

## Ground rules

- **No commit, no push, no branch.** Leave the work uncommitted.
- **Do not touch the issue tracker.** Only the coordinator owns beads.
- Prefer zero new dependencies. `deadcode` is a Go tool installed via `go install`; check how
  `.githooks/pre-commit` handles `gofumpt` and `golangci-lint` (it has a `check_cmd` helper with
  an install hint) and follow that pattern exactly rather than adding a vendored binary. If
  `knip` must become a devDependency, say so and justify the size.
- Report **numbers, not adjectives**: baseline counts per language before and after config, hook
  wall-time before and after, and the exact output of your deliberate-violation test.

## Lifecycle

Send a `heartbeat` with `--phase` at every phase change (reading lint-fixtures, Go half, knip
config, TS half, hook wiring, proving the failure). One `worker_done` when finished, with
`--outcome succeeded` or `--outcome failed`.
