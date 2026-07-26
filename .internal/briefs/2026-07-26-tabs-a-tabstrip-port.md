# Worker brief — TABS-A (bead `nocx-u5og`)

## Read first

- Design: `/home/dev/repos/nocx/.internal/specs/2026-07-26-tab-and-settings-foundation-design.md`
  — read **sections B.1 and B.3** in full, plus B.8 for context on what is coming next (you do
  not implement B.8).
- `AGENTS.md` in your worktree — binding. Especially TDD, interface-first + DI at a single
  composition root, SRP, and **no backward-compatibility shims**.

## The task

Extract **all** tab chrome and DOM placement out of `TabManager` and `Tab` into a `TabStrip`
presentation port, and ship the **horizontal** implementation reproducing today's behaviour
exactly.

- `Tab` becomes state + lifecycle. It does **not** own tab-button DOM.
- `TabStrip` creates, places and styles chrome, and emits intents: **activate, close, new-tab,
  reorder**.
- `TabManager` owns the ordered tab model and the activation rules, and consumes intents.

### Why this is being done now

`TabManager` currently constructs the tab-list container itself (`frontend/src/tabs.ts:808`)
and directly reorders button DOM (`tabs.ts:1127`). That is exactly the coupling the
configurable-placement epic exists to remove. If it stays, the next epic refactors what this
one just built. Your port is the seam a **vertical** implementation will later plug into
without reopening your work — design it so that is true.

### The duplication you are collapsing

The tab-button wiring — click, close, middle-click, `dragstart`, `dragend`, `dragover`,
`drop` — exists in **two near-identical copies**:

- `newManagerTab` — `tabs.ts:937-969`
- `createTab` — `tabs.ts:1006-1040`

It must end up in **one** place. Do not create a third copy.

### Keyboard and ARIA belong here, not to a later retrofit

The tab button is a `div` today (`tabs.ts:64`). Under a "no quick wins" brief, doing this once
now is cheaper than retrofitting:

- roving `tabindex`
- Left/Right in horizontal placement, and the port shaped so Up/Down works for a future
  vertical placement
- Home/End
- `focus-visible` behaviour
- a stable tab ↔ tabpanel relationship
- **record a decision** on whether drag-reorder gets a keyboard equivalent. Either implement it
  or state plainly that you did not and why — do not leave it unmentioned.

### One behaviour change, taken from Orca

Closing the **active** tab must activate the **previously active** tab (an MRU stack), not the
visual neighbour as `tabs.ts:1086-1088` does today. Orca keeps `recentTabIds` per tab group
for exactly this. Test it: open three tabs, activate 1 → 3 → 2, close 2, expect 3.

## Explicitly NOT in this task

- Do **not** introduce `TabContent`, `TabHost`, `SettingsContent` or any content seam.
- Do **not** delete `managerView` or move terminal machinery out of `Tab`. `Tab` keeps its
  renderer, session, editor, scrollback, ledger and input state for now — a follow-up task
  extracts them. Your job stops at the chrome/DOM boundary.
- Do **not** touch where settings are mounted.

Resisting scope creep here is part of the task: the next worker's job depends on your port
being clean rather than large.

## Files you own

- `frontend/src/tabs.ts`, `frontend/src/tabs.test.ts`
- new files for the port, e.g. `frontend/src/tab-strip.ts` and its test
- `frontend/src/style.css` — only the tab-chrome rules
- `frontend/src/main.ts` — only the composition-root wiring the port needs

Do **not** touch `frontend/src/settings.ts`, `frontend/src/profiles.ts`,
`frontend/src/ipc.ts`, or anything under `internal/`. Another worker owns the settings and
transport files. If you believe you must cross that boundary, **escalate instead of crossing
it**.

## Safety net

`frontend/src/tabs.test.ts` is your net for this extraction, but note it is coupled to
renderer and session mocks from its first test (`tabs.test.ts:42`). Part of the value here is
that the port makes a **third** test layer possible: tab-strip presentation tests with no
terminal machinery at all. Add that layer.

## Bootstrap in your worktree

```bash
cd frontend && npm ci && cd ..
```

## Verification — run all of it, in your own worktree

You are in an isolated worktree, so whole-project gates are safe here and are **required**:

```bash
cd frontend && npm run format:check && npm run lint && npm run typecheck && npm run test
cd .. && gofumpt -l . && golangci-lint run ./... && go test -race -count=1 ./...
```

(The Go gate should be untouched by your change — run it to prove that.)

**Baseline before blame.** The Playwright e2e suite is **red on `main`** — 13 tests fail
(`nocx-bw2`) and Playwright is not in the per-commit gate. Do not run it, do not chase it, and
do not claim anything about it. If a vitest test fails, prove whether it is pre-existing
before attributing it to your change:

```bash
git stash -u && <run the gate> && git stash pop
```

## Ground rules

- **Do not commit. Do not push. Do not create a branch.** The coordinator owns git.
- **Do not touch the issue tracker.** No `bd` commands at all — the coordinator owns beads.
- Do not run `prettier --write` or `gofumpt -w` across the repo. Format only the files you
  changed.
- TDD: red → green → refactor.
- Report **numbers, not adjectives**: test counts before and after, every lint suppression you
  added with its justification, and every problem you spotted and deliberately left alone.
- **State explicitly anything you could not verify** — including any behaviour you could not
  exercise in jsdom (drag-and-drop, focus-visible, real layout measurement). Silence there
  will be read as "nothing to report", and that has burned us before.

## When you are done

Report through `worker_done` exactly as your dispatch preamble instructs, including the
`taskId`, `dispatchId` and coordinator handle it gave you. In the body include:

1. The port's interface as actually implemented — the intents and their signatures.
2. What moved out of `Tab` and `TabManager`, and what deliberately stayed.
3. Gate output — the real numbers.
4. The drag-reorder keyboard decision.
5. Anything you could not verify, and anything you deliberately left.
