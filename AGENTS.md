# AGENTS.md — Working rules for AI agents on `nocx`

`nocx` is a local-first, Warp-style terminal (Go backend + xterm.js frontend + Wails v2
desktop). This file is the operating contract for **any** AI agent (Claude Code, Cursor,
OpenCode, …) contributing to the repo. Read it before writing code.

## Read first (sources of truth)

- [`docs/vision.md`](docs/vision.md) — what we're building, MVP scope, roadmap.
- [`docs/architecture.md`](docs/architecture.md) — the architecture spine: invariants
  (`AD-1`…`AD-10`), module boundaries, the WebSocket protocol. **The ADs are binding.**
- The task backlog lives in **beads** (`bd`), not in prose. Get work with `bd ready`.
- **New here?** The [README setup](README.md#agent-tooling) is the full install guide —
  the toolchain *and* the per-machine agent tooling (`bd`, the `beads-superpowers`
  plugin, and optional `graphify`). `make init` does not install any of it.

## First thing in a fresh clone

Two kinds of setup, in order. **First, install the tooling on your machine** — the
toolchain (Go, Node, Wails, `bd`) *and* the agent tooling that is not vendored:
the [`beads-superpowers`](https://github.com/DollarDill/beads-superpowers) Claude
Code plugin (Superpowers skills + the `bd` session hooks) and, optionally,
`graphify` for knowledge-graph code search. The [README](README.md#agent-tooling)
has the exact commands; `make init` installs none of it and assumes the tools
already exist.

**Then wire up the repo:**

```bash
make init
```

Run it before touching code. Git carries neither the issue database nor the ref
it lives on, so until `make init` has run there is **no backlog**: `bd ready`
answers "no beads database found", and an agent that reads `.beads/issues.jsonl`
instead is reading a passive export that may lag the database.

After that, task state syncs by itself and you should not sync it by hand:

- `git commit` writes and stages `.beads/issues.jsonl`, so the snapshot travels
  in the same commit as the work it describes.
- `git push` runs `bd dolt push`, which is what a fresh clone actually reads.

If a push stops with a beads failure, fix the sync — do not reach for
`--no-verify`. That path leaves everyone else on a backlog that looks current
and is not, which is precisely the failure this setup exists to prevent.

## Repository layout

- `docs/` — living source-of-truth docs (`vision.md`, `architecture.md`, `decisions/` ADRs).
- `AGENTS.md` — this file (the agent rules). `CLAUDE.md` only points here.
- `_bmad/`, `.claude/`, `.agents/`, `.opencode/` — vendored BMAD agent tooling.
- Code directories appear as the app grows — follow the module map in `docs/architecture.md`.

## How we work

1. Take the next task from beads — the one command in [What to work on
   next](#what-to-work-on-next), not a bare `bd ready`, and claim it with the three-step
   protocol below, not a bare `bd update --claim`.
2. Read the relevant `AD`(s) in `docs/architecture.md` before touching a boundary.
3. **TDD**: red → green → refactor. Write the failing test first.
4. Keep it green: language-specific format, lint, and tests all pass (pre-commit runs them).
   The pre-commit hook is the gate on every commit; CI validates release branches and tags.
5. Update the task in beads; record any non-obvious decision as an ADR in `docs/decisions/`.

### Before you investigate: two cheap checks that beat reasoning

Both of these were learned by skipping them and losing an afternoon.

**Search the memories before fighting the environment.** `bd memories <keyword>`
costs seconds. A session spent installing Xvfb, chasing an `EGL_BAD_PARAMETER`
abort and rebuilding NixOS twice to get the Playwright suite running ended when
`bd memories e2e` turned up a memory describing `cmd/devharness` plus the
`NOCX_WS_PORT` shim in `e2e/harness.ts` — a headless path needing no wails, no
GTK and no display at all. It had been in the repo the whole time. Memories are
pull-based: nothing surfaces them for you, so ask.

**When a branch behaves differently from `main`, diff it against `main` first.**
Before measuring, instrumenting or theorising:

```bash
git diff origin/main...HEAD -- <path> | grep '^-'
```

A large feature commit can silently drop a line, and the symptom will look like
anything but a deletion. `557e87d` (52 files, +8025/−605) removed one
subscription — `tab.onBufferChange = () => … syncAltScreenClass()` — and the
visible result was a Playwright click timing out on a button that hit-testing
reported as visible. Reasoning about geometry and DOM measurement took hours;
the removed-lines diff found it in a minute and, swept across the whole
directory, proved nothing else had been lost.

### What to work on next

Asked to "keep going" with no further instruction, this is the whole answer:

```bash
bd ready --exclude-type epic -u -n 10
```

It returns 7 issues across the 4 active tracks, not the 68 it returned on 2026-07-26 before
the backlog was sequenced (nocx-k0xk.1). Take the top one and claim it with the three-step
protocol below. **If it returns nothing, that is an answer, not a bug** — every active
track's front is occupied. Finish something in flight, or promote the next epic
deliberately; do not go hunting for work with a wider query.

Four invariants keep that command honest. Break one and the noise comes back.

**Blocking an epic parks its whole track.** This is the load-bearing mechanic and it is not
obvious: in beads, a blocked parent propagates to its children, so a child with no `blocks`
edge of its own is still excluded from `bd ready` when its epic is blocked. Verify it rather
than trusting this paragraph — `nocx-d3q.1` has no dependencies and is not ready, because
`nocx-d3q` is blocked. So "we are not working on X right now" is recorded as an edge:

```bash
bd dep add <parked-epic> <active-epic>    # parked-epic depends on active-epic
```

`blocks` therefore carries two meanings — a technical dependency and a deliberate
sequencing decision — and which one applies is recorded in the epic's own description, not
inferred from the edge. Both mean the same thing operationally: not now.

**The active track is an epic in `in_progress`; every other epic is blocked on them.** That
is the only place "what matters now" is written down. Not a label (needs hand-syncing, goes
stale silently), not priority (then priority stops meaning priority, and switching tracks
means re-prioritising dozens of issues), not `deferred` (already used for knowledge beads —
`bd list --label kb --status all`). Note that `blocked` is *computed*, never stored:
`bd query "status=blocked"` returns nothing while `bd stats` counts 23. You cannot set it;
you can only add the edge that causes it.

**An epic is a DAG, not a bag.** Children are wired with `blocks` so the epic exposes at most
three entry points. The check is the front itself:

```bash
bd ready --parent <epic> --exclude-type epic -n 100 --json | jq 'length'   # must be ≤ 3
```

Do **not** use `bd swarm validate` for this — it counts closed children in its waves, so it
reports max parallelism 7 for an epic whose real front is 3. It is useful for reading the
shape of an epic, useless as a gate. An epic where every child sits in wave 1 has recorded
no order at all, and that is what made `bd ready` unusable as a queue in the first place.

**An epic has three states, and the third one is the useful one.** `in_progress` means
somebody is working it *right now*. Blocked means parked, or waiting on its predecessor in
someone's stream. Plain `open` and unblocked means **free to hand to a colleague** — and
that is a feature, not an oversight:

```bash
bd ready -t epic -u        # epics nobody owns and nothing blocks — what you can give away
```

Do not mark an epic `in_progress` to stop it appearing in a task listing. That is backwards,
and it was done once here: three epics were flipped to `in_progress` purely to keep a bare
`bd ready` clean, which then reported five active tracks when the owner was running three.
The status has to describe reality; `--exclude-type epic` is what keeps epics out of a
task-level query.

Corollary worth checking for, because it hides: a child sitting `in_progress` inside a
*blocked* epic means work is happening in a frozen track. Usually it is a stale claim from
an earlier session rather than live work. `bd list --status in_progress` against the epic
states finds them.

**An epic is a unit of assignment.** It is handed to one person whole — never "this epic
but not those three children". That is why `nocx-6ek` (Persistence) and `nocx-k0xk` (Quality
gates) were closed and split: an epic named after an *area* can never finish, because every
new bug in that area lands in it, so it can only ever be cherry-picked. Scope an epic to a
deliverable whose DONE WHEN stops being false exactly once. More, smaller epics is the
correct trade — the backlog went from 15 to 23 and that was the point, not a side effect.

**Where a bug goes.** Inside a live deliverable, it is a child of that epic — `nocx-au6`
belongs to deleting wterm because the seam lying about capabilities is part of that job. A
bug that arrives from nowhere gets **no parent at all**: a standalone bug is legitimate and
shows up in `bd ready` on its own. Do not file it under the nearest plausible epic — that
reflex is exactly what grew the two area epics, one honest-looking parent at a time. If
triage shows the bug is a symptom of something structural, it *becomes* an epic (or spawns
one) and carries a `discovered-from` edge back to itself, the way `nocx-4ff` points at
`nocx-gs0` and the way `nocx-bw2` anchored `nocx-rdkh`.

**Epics are never workable, and claims are unassigned-only.** Always `--exclude-type epic`:
an epic is a container and a synchronisation point, and claiming one is always a mistake.
Always `-u` when listing and `--claim` when taking — that is what lets two agents work two
tracks at once without coordinating, neither able to pick up the other's work.

When a track finishes, unparking is one deliberate act: close the epic, then wire the
children of whichever epic becomes active — sequencing it *before* it goes `in_progress`,
never after.

### Claiming work on a shared backlog

Several people work this repo from their own machines against one shared issue database
(`refs/dolt/data` on the git remote). Claim in three steps, never just the middle one:

```bash
bd dolt pull                # see who took what since your last sync
bd ready && bd update <id> --claim
bd dolt push                # publish the claim now, not at your next git push
```

`git pull` refreshes the backlog on its own (`.githooks/post-merge`, `post-rewrite`), and
`git push` publishes it (`.githooks/pre-push`). The explicit pull/push above exists because
claiming is the one moment where minutes of staleness cost somebody a duplicated afternoon.

**A claim is not a lock.** Two people can claim the same bead from two clones; both pushes
land, Dolt merges them, last write wins. The protocol shrinks the race window — it does not
close it. Auto-push (`dolt.auto-push`) stays off on purpose: upstream warns that concurrent
pushes to a git-protocol Dolt remote can corrupt or strand remote history. If claim races
ever become routine, the fix is a shared Dolt sql-server, not a shorter interval (nocx-wj4).

## Git authority

Agents have **standing authority to commit and push** on this repo. This overrides the
"Conservative (default)" profile in the managed Beads block below — that block defers to
repository instructions, and this is one. It lives here rather than inside the block
because the block is regenerated from a hash and edits to it are lost.

Allowed without asking, every session: `git commit`, `git push`, `bd close`,
`bd dolt push`, and running the quality gates. Branch first if you are on `main`.

**Merging a pull request always requires explicit approval.** Not a green-CI one, not
your own, not a one-line one — the user has to ask for it in that session. Authority to
commit and push is not authority to merge, and approval to merge one PR does not carry
to the next.

Run the full local gate before pushing, not only the part you touched: `gofumpt -l .`,
`golangci-lint run`, `go test -race ./...`, plus `npx prettier --check .`, `npx eslint .`,
`npx tsc --noEmit`, `npx vitest run` for frontend changes.

## Engineering rules (non-negotiable)

- **Interface-first + DI.** Every module lives behind an interface, wired at a single
  composition root. Depend on abstractions, obey SRP, keep modules trivially replaceable.
- **Quality gates from every commit:** language-specific formatting, linting, and test,
  enforced by the pre-commit hook. Mandatory tests for every language — Go and TypeScript
  are held to the same bar.
- **Observability:** structured logging via Go `log/slog` behind the logging interface —
  no ad-hoc `fmt.Println`.
- **Clean-only:** no backward-compatibility shims (greenfield — break & refactor freely),
  no dead code (delete it), no quick-win hacks. YAGNI — don't build speculative features.
- **Respect the spine.** Don't violate an `AD` to save time; if an `AD` is wrong, change it
  in `docs/architecture.md` deliberately rather than routing around it. E.g.: never wrap PTY
  bytes in JSON-RPC (AD-1 data plane); the backend never sniffs the byte stream (AD-6);
  session-id is server-authoritative (AD-7).

## Stack

- **Backend:** Go — `pty`, `ssh` (via `golang.org/x/crypto/ssh`), `session`, `transport`,
  `config`. One core, multiple build targets.
- **Frontend:** xterm.js (WebGL) + TypeScript UI. Terminal render state lives here (AD-6).
  wterm remains switchable behind `TerminalRenderer` for re-testing — see
  [ADR-0001](docs/decisions/0001-xterm-js-as-vt-frontend.md).
- **Desktop shell:** Wails v2 (macOS first).
- **Transport:** one WebSocket — raw **binary** data plane + **JSON-RPC 2.0** control plane (AD-1).

## Current top risk

The VT-frontend risk was settled in
[ADR-0001](docs/decisions/0001-xterm-js-as-vt-frontend.md).
Next risk to watch: run `bd ready`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
