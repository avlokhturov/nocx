# Brief — nocx-wzc4.7: Ports belongs in the activity bar

Supervised worker. Read this whole file first. Work in the worktree you are in.

## Ground rules

- **No commit, no push, no branch.** **Do not touch `bd`.**
- Gates, from `frontend/`: `./node_modules/.bin/tsc --noEmit`,
  `npx eslint src/ --max-warnings 0`, `npx prettier --check src/`,
  `npm test -- --run`. Plus `go build ./...` if you touch Go.
- Another worker is in `internal/shellintegration` test files and `.githooks` —
  stay out of both.
- Report by writing `.internal/reports/nocx-wzc4.7-ports-view.md` with what
  changed, test counts before/after, and anything you could not verify. The
  coordinator reads the worktree; you do not need the orchestration CLI.

## The decision

The owner's call: the ports panel does not belong in the command palette, and it
does not belong in a tab.

Quick connect is for one-shot verbs — "new tab", "integrate this shell". Ports is
a surface you keep open and glance at; putting it in the palette turns the
palette into a menu.

And a tab **replaces the terminal**, which makes it impossible to watch a port
appear while typing the command that opens it. The reference the owner gave for
this feature — Orca's PORTS panel — sits beside the terminal for exactly that
reason. I took the contents from that screenshot and lost the placement.

The owner has now asked twice where the activity-bar icon is. That icon is the
deliverable.

## Where it goes

`frontend/src/sidebar.tsx` already has the contract: `mountSidebar` takes
`SidebarViewDescriptor` (`id`, `title`, `icon`, `view`, `actions`, `order`), and
`main.tsx` passes `[]` today with a comment reserving the views zone for
`nocx-708q`. **You are its first real view.** Read `sidebar.tsx` before writing
anything, and if the descriptor is missing something you need, say so in your
report rather than working around it — a first consumer bending itself around a
contract is how the contract stays wrong.

Read `frontend/src/ui/README.md` and list `frontend/src/ui/` before building any
control. A surface may place a kit component and may never repaint it.

## What must be true when you are done

- Ports is a sidebar view with an activity-bar icon, and the palette item is
  **gone**. "Integrate this shell" **stays** in the palette — it is a verb and it
  belongs there.
- The view follows the **active tab** rather than capturing a profile when it
  opens. Switching SSH tabs re-scopes it; a local tab must not show a stale
  host's ports.
- Sampling still pauses when the view is not visible, and **collapsing the
  sidebar counts as not visible**. The plumbing exists (`setVisible`) — route it,
  do not rebuild it.
- `Ctrl/Cmd+Shift+O` becomes reveal-or-focus for the view, not "open another".
- A test asserts a user can open it from the activity bar and see the ports of
  the tab they are looking at. `AGENTS.md` rule 1: mounting the component proves
  it renders, which was never the thing in doubt.

`frontend/src/ports-surface.ts` exists to register Ports as a tab surface. If
that is no longer the right shape, delete it rather than leaving two routes to
one panel — a second vocabulary for one concept is the defect two epics were
spent unwinding.
