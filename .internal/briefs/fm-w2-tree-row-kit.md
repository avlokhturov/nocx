# W2 — `ui/tree-row`: the kit's first tree-shaped component

## Where you are

You are in your OWN git worktree. **Run `pwd` first and use that path for everything.**
Never write to `/home/dev/orca/workspaces/nocx/feat-file-manager-2` — that is the
coordinator's checkout.

## Read this first, in this order

1. **`frontend/src/ui/README.md`** — the kit inventory and its rules. This is the binding
   document for anything in `ui/`, and reading it first is not optional here.
2. `.internal/specs/2026-08-06-file-manager-design.md` §5.4, the "Kit only" paragraph.

The issue tracker is NOT in your worktree; `bd` will find nothing. Everything is in this brief.

## Why this component exists at all — so you do not reinvent the decision

Neither reference product had an off-the-shelf tree to copy: Orca hand-writes ~41 files over
`@tanstack/react-virtual`, termic hand-writes its own over Radix, and both are React while we
are Solid. Kobalte, the Solid equivalent, was measured and rejected in
`.internal/specs/2026-07-27-kobalte-spike-report.md` — ~34 KB gzip of shared core against a
25–35 KB total budget — and has no tree primitive regardless. So this is written by hand,
deliberately.

**Check `CollectionView` (`src/ui/collection-view.tsx`) before you write a line.** If its row
variance already fits, extend it rather than fork it. The kit grows by variants, never by
near-duplicates. If you extend it instead of adding a new module, say so in your report and
adjust the README row accordingly — that is a better outcome, not a deviation.

## What you own — and nothing else

- `frontend/src/ui/tree-row.tsx` (or the extension to `collection-view.tsx`, if that is the
  right answer)
- `frontend/src/styles/components/tree-row.css`
- `frontend/src/ui/tree-row.test.tsx`
- the one new row in the table in `frontend/src/ui/README.md`

Nothing else. Do not touch `src/sidebar.tsx`, `src/main.tsx`, `src/tabs.ts`, anything under
`internal/`, or any other file in `src/ui/`. Other workers own those.

**Do not build the Files panel.** That is a later wave. You are building the row, alone,
renderable from a test.

## What the row must do

A tree row is one line in a file tree. It must express, as **typed `data-*` attributes** rather
than as caller-supplied colours or markup:

- **depth** — indentation, driven by a number, not by nested DOM
- **disclosure** — expandable / expanded / collapsed / leaf, and a busy state while a directory
  is loading
- **kind** — directory, file, symlink; and a **cyclic** symlink, which renders as a leaf that
  cannot be expanded
- **state** — selected, focused, disabled/unreadable (permission denied is a real state that
  must render, never a silently empty row)
- **name**, with overflow as ellipsis and never a clipped glyph
- an optional trailing slot for a badge

Accessibility: the disclosure control is reachable and operable from the keyboard, and the row
announces its expanded state. Follow whatever the kit already does for this — do not invent a
second pattern.

## The rules that are actually enforced here

- **One stable identity class** (`ui-tree-row` plus `__` element classes), because the kit
  identity gate scans for them. See `lint-fixtures/check-kit-identities.mjs` and
  `lint-fixtures/scan-kit-identities.mjs`.
- **No colour literals.** Every colour is a `var(--token)`. `lint-fixtures/check-css-colors.mjs`
  enforces this and it will fail you.
- **No raw controls.** A clickable disclosure is a kit control, not a bare `<div onClick>`.
- One CSS file in `styles/components/`, imported the way the kit already imports them.
- A surface may later **place** this component; it may never **repaint** it. So every visual
  decision belongs in your CSS file, and anything a caller might want to vary is a `data-*`
  variant you provide — not a prop that takes a colour.

## Verify — scoped to your own files, with one deliberate exception

```
./node_modules/.bin/vitest run src/ui/tree-row.test.tsx     # run from frontend/
./node_modules/.bin/tsc --noEmit                            # run from frontend/
```

The type-check is repo-wide and that is **on purpose**, despite the general rule against
repo-wide gates. The reason is specific: vitest strips types and runs, so a file can pass its
tests and not compile. That has shipped here twice. If `tsc` reports errors in files you do not
own, **report them, do not fix them** — they are another worker's and they are not your blocker.
Errors in your own files are blocking.

Do **not** run `npm run lint`, `npm test` (whole suite), `prettier --write`, or any other
repo-wide gate. Formatting is a separate final wave.

Run the two kit gates on your own file, though, because they are what will reject it:

```
node lint-fixtures/check-css-colors.mjs
node lint-fixtures/check-kit-identities.mjs
```

## Tests

Assert what a user can do, not what the code does. The row renders at a depth; the disclosure is
present and operable for a directory and absent for a file; activating it reaches the callback;
a cyclic symlink offers no disclosure; an unreadable row renders its state rather than nothing.
A test written by reading the implementation cannot report a missing feature.

## Ground rules

- **No commit, no push, no branch.** Leave the work uncommitted.
- **Do not touch the issue tracker.** Only the coordinator owns beads.
- **No new dependencies.** If you think you need one, escalate.
- Report **numbers, not adjectives**: test count, gate results, and anything you could not
  verify. Silence where the brief asked you to report is read as "nothing to report", so if you
  skipped something, say which.

## Lifecycle

Send a `heartbeat` with `--phase` at every phase change (reading the kit, component, CSS, tests,
README). One `worker_done` when finished, with `--outcome succeeded` or `--outcome failed`.
