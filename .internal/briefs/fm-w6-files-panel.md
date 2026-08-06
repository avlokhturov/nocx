# W6 — the Files panel: the first icon in the activity bar

## Where you are

You are in your OWN git worktree. **Run `pwd` first and use that path for everything.**
Never write to `/home/dev/orca/workspaces/nocx/feat-file-manager-2`.

The issue tracker is NOT in your worktree; `bd` will find nothing. Everything is here.

## Read these, in this order

1. `frontend/src/sidebar.tsx` — `SidebarViewDescriptor` and `SidebarViewProps` already exist.
2. `frontend/src/ports.tsx` + `frontend/src/ports-client.ts` — **the shape you are matching.**
   Ports is the activity bar's other view and yours should read like a sibling of it.
3. `frontend/src/ui/tree-row.tsx` — already committed. Your rows are this component.
4. `frontend/src/generated/files.*.ts` — already committed. Your client returns these types and
   **declares nothing of its own**.
5. `.internal/specs/2026-08-06-file-manager-design.md` — **§5.4 in full**, plus §5.2 for the wire
   and D2, D4, D9, D10, D14 in §3.

## What you own — and nothing else

- `frontend/src/files/**` — a new directory: the view, the client, the tree store.
- `frontend/src/sidebar.tsx` — **only** to add `activeOrigin` to `SidebarViewProps`.
- `frontend/src/tab-content.ts` and `frontend/src/tabs.ts` — **only** to add the optional
  `activeOrigin()` capability to the `TabContent` seam and to have `TabManager` ask the active
  tab for it. Keep these edits minimal and additive; they are shared surfaces.

**You do NOT own `main.tsx`.** Export a registration function; the coordinator wires it. Another
worker is building the viewer tab at the same time, and `main.tsx` is the one file you would
both want.

Do not touch `internal/**`, `contracts/**`, `frontend/src/ui/**`, or anything under
`frontend/src/generated/`.

## The seam to the viewer — agreed in advance, do not invent your own

Opening a file is the panel's primary action, but the viewer is another worker's. So the panel
takes an opener as a dependency and calls it:

```ts
export interface FileOpener {
  open(target: {
    bindingId: string
    endpointId: string | null
    path: string // lexical, as listed
    canonical: string // from files.read / files.list — the identity
    displayHost: string | null // null for local
    name: string
  }): void
}
```

Accept it as a prop or a module-level injection point, your choice, but that signature is fixed.
Provide a no-op default so the panel is testable and runnable before the viewer lands.

## Build it

### The view descriptor — and it is FIRST

Register with an `order` **below Ports**, so Files is the top icon in the activity bar's view
zone. That is an owner requirement, not a consequence of a number: assert it in a test.

Panel header: the root's display path, a **refresh** action, and space for the polling badge
(§5.5) — the badge itself belongs to the watching wave, but leave the slot and do not invent a
different one later.

### `activeOrigin`, and why it is not `activeProfileId`

`SidebarViewProps` exposes only `activeProfileId()`, which was designed for Ports and cannot
express what Files needs: an alias tab has no profile, a profile is editable, and local is the
synthetic string `"local"` (`ports-client.ts:11`). Add:

```ts
activeOrigin: () => { tabId: number; sessionId: string; kind: 'local' | 'ssh'; cwd: string | null; cwdVerified: boolean } | null
```

`TabManager` must ask the **active tab** for this through the `TabContent` seam — an optional
capability method that terminal content implements. It must **not** be an
`instanceof TerminalContent` branch: `tabs.ts:698` already has one of those and a second would
make `TabManager` own a growing switch over content classes, against the polymorphism the seam
exists for. The viewer worker will implement the same capability on its content, which is how
the panel keeps showing the right machine when a viewer tab is focused.

### The client

One module under `files/`, modelled on `ports-client.ts`. It calls `files.open`, `files.list`,
`files.read`, `files.close` through the existing dispatcher and returns the **generated** types.
Do not declare a result interface of your own — a hand-written type can want a field the wire
does not carry, which is the defect the whole `contracts/` directory exists to prevent.

### The tree, and the four rules that make it correct

1. **Root comes from `files.open` and does not move.** The tab's root is fixed at open; a later
   `cd` does not re-root the tree. An `inferred` root is labelled in the header — AD-5 requires a
   fallback to be surfaced, not applied silently.
2. **Stale responses are dropped, and nothing client-minted goes on the wire.** The JSON-RPC id
   already correlates a result with its request, and the code that issued the call already knows
   in its own closure which `{tabId, generation, bindingId}` it issued for. So capture that
   triple at call time and apply the result only if it still matches the view's current state and
   the generation is not older than what has been applied. This is what stops a `files.list` for
   tab A, still in flight when the user activates tab B, from painting A's listing into B's tree.
3. **Cycle detection is yours, and it costs no extra call.** Every `files.list` result carries
   `canonical`. When you expand a directory symlink, compare the returned `canonical` against the
   canonicals you already hold for its expanded ancestors; on a match, mark the row cyclic, do
   **not** commit the returned children, and do not request it again. Compare **before**
   rendering, so the children never flash.
4. **`state` is a discriminator, and you switch on it first.** `files.list` returns
   `state: 'ok' | 'tooLarge' | 'timedOut'`. `tooLarge` renders as a real state — "this directory
   has more than N entries" — with no pagination offered. `timedOut` renders as its own state
   with a retry. Neither is an error toast and neither is an empty directory.

Pagination is "show next N" (D10), never virtualised rows. Permission denied is a rendered node
state, never a silently empty directory. Dotfiles are shown.

## Verify — scoped, with the type-check as the deliberate exception

```
cd frontend
./node_modules/.bin/vitest run src/files          # your tests
./node_modules/.bin/tsc --noEmit                  # repo-wide, on purpose
```

`tsc` is repo-wide deliberately: vitest strips types and runs, so a file can pass its tests and
not compile — that has shipped here twice. Errors in files you do not own: **report, do not fix**.

Do **not** run `npm run lint`, the whole `npm test`, `prettier --write`, or any Go gate.

## Tests — assert what a user can do

The bar from `AGENTS.md`, and it has teeth here: a connection manager once shipped with **no way
to create a group** behind 1041 green frontend tests, every one of them mounting a component and
asserting what it rendered. So:

- The Files icon exists in the activity bar, **is the first one**, is enabled from a cold start,
  and clicking it opens the panel.
- Expanding a directory reaches the client method; the returned entries appear as rows.
- "Show next" reveals the rest.
- Clicking a file row reaches `FileOpener.open` with the right target — the seam a person
  actually touches.
- Switching tabs mid-flight does not paint one machine's listing into another's tree. This is the
  §0 test and it is the most important one in your set.
- A directory symlink whose canonical matches an expanded ancestor renders cyclic and lists no
  children.
- `tooLarge` and `timedOut` each render their own state.

Fake the client at its boundary; do not stand up a backend.

## Ground rules

- **No commit, no push, no branch.** Leave the work uncommitted.
- **Do not touch the issue tracker.** Only the coordinator owns beads.
- **No new dependencies.**
- Report **numbers, not adjectives**: test count, tsc result, what you could not verify, and any
  place the spec was silent where you had to choose.

## Lifecycle

`heartbeat` with `--phase` at every phase change (client, store, view, tests). One `worker_done`
at the end, `--outcome succeeded` or `--outcome failed`.
