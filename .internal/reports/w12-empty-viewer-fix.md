# W12 — the file tab opened empty: diagnosis and fix

## Diagnosis (reproduced first, on the wire)

Reproduced exactly as E2E-REPORT.md describes: 2 failed / 2 passed, check 4 failing with
`.file-viewer__editor` textContent `""` for the full 20 s window. An instrumented probe
(driven through the product's own seam — same `cd` + tab-switch flow) captured the
WebSocket frames and the viewer's rendered state:

```
SEND id=81 files.read binding=d2718f… path=…/notes.md maxBytes=0   ← panel's canonical read
RECV id=81 {text:"hello from the fixture\n", canonical:…/notes.md}  ← OK
SEND id=82 files.read binding=d2718f… path=…/notes.md maxBytes=0   ← the VIEWER's read
SEND id=83 files.close binding=d2718f…                            ← the panel closed the binding
RECV id=82 {text:"hello from the fixture\n"}                       ← viewer read succeeded ON THE WIRE
RECV id=83 {}
```

Viewer samples: notice bar = `unavailable: "Source unavailable — the terminal or
connection that provided this file is gone"`, editor empty, Reload present.

**Root cause.** Opening the viewer tab ACTIVATES it (`addTab` → `activate`, tabs.ts:571).
`activate` fires `onActiveTabChange` after mount (tabs.ts:692), and `TabManager.activeOrigin()`
returns **null** for a viewer tab — `FileViewerContent` never implemented the optional
`activeOrigin` capability, so the Files panel's origin signal went null. The store's
`rescope(null)` closed the binding (`files-store.ts`, the close in rescope). That close is
the `filesServicesTracked.close` in main.tsx: it removes the id from `liveFilesBindings` and
fires the liveness callbacks with `false`; the viewer — correct per its D7 contract — bumped
its generation, dropped the in-flight read result, and rendered "source unavailable". The
three candidates the brief ruled out were all correctly ruled out: `maxBytes:0` never
mattered, `mount()` was fine, and the liveness wiring was fine — the binding legitimately
died between the viewer's read and its result.

This is a missing implementation of the design, not a new idea: §5.4 "Panel focus" says a
viewer tab "answers with the binding it was opened from and the panel keeps showing that
machine", and §5.4 `activeOrigin()` says "viewer content answers from the binding it was
opened with".

## Fix (three coordinated changes, one contract)

1. **`files-view.tsx` — `FileOpener.open` target gains `origin`** (the panel's click-time
   scope, minus `tabId`); `openFile` passes it.
2. **`file-viewer-content.tsx` — `FileViewerTarget.origin` + `FileViewerContent.activeOrigin()`**
   answers it. The viewer now speaks for the machine its file came from.
3. **`files-store.ts` — the rescope guard scopes on session+kind, not `tabId`.** A viewer tab
   answering its source session is the SAME machine with a different tabId; re-opening there
   would close the very binding the viewer is reading through. (The `tabId` in `ListCtx`
   staleness guards is untouched — rule 2 still drops a listing for tab A that lands after
   tab B activates. Two terminal tabs never share a session, so this changes nothing for
   them; the store tests "does not re-open on same session (rule 1)" and "a different tab
   re-scopes" still pass.)

### The untested seam, and why its absence let this through

The viewer's 24 unit tests and the store's tests each proved their own module correct —
the untested seam was the **interaction**: a viewer tab becoming active re-scopes the
origin-following panel, and the panel's binding lifecycle closes the binding the viewer is
mid-read on. No single-module test could see it: the viewer's tests never activate a tab
through TabManager, and the store's tests never open a viewer. The regression test pins the
interaction at its two ends:

- `files-store.test.ts` — "a viewer tab answering its source session keeps the binding
  (design §5.4)": `rescope(LOCAL_A)` then `rescope({…LOCAL_A, tabId: 99})` must not call
  `close`. **Fails against the old code** (verified: `expected "spy" to be called 1 times,
but got 2 times` — the old guard closed and re-opened).
- `file-viewer-content.test.ts` — "answers the origin the viewer was opened with, minus the
  tabId" (and the null case).

## Acceptance — verbatim before / after

Before (this worktree, documented recipe):

```
  2 failed
    [chromium] › e2e/files.spec.ts:93:5 › cold start: the Files icon is first in the activity bar, present and enabled, panel collapsed
    [chromium] › e2e/files.spec.ts:150:5 › clicking a file opens a tab whose content matches the file and whose title is the basename alone
  2 passed (30.2s)
```

Check 4's failure detail: `expect(locator('.file-viewer__editor')).toContainText("hello from the fixture")` — Received `""`, 43 polls over 20 s.

After (spec updated per the in-scope instruction, see below):

```
  4 passed (4.7s)
  [1/4] cold start: the Files icon is first in the activity bar, present and enabled; the panel is open on Files
  [2/4] the Files icon toggles the panel; open, the tree shows the origin root
  [3/4] expanding a directory lists a page and "show next" reveals the rest
  [4/4] clicking a file opens a tab whose content matches the file and whose title is the basename alone
```

Check 4 now also runs the title half that never executed before: `notes.md` basename alone,
no `·` separator, on a local origin.

## Also in scope: check 1 (verified, then the spec corrected)

The cold-start-open behavior **predates the epic**. `mountSidebar`'s "Fix nocx-rp2j:
correct initial state" (sidebar.tsx:376-390) landed 2026-07-27 in `f1621f2` (nocx-hois,
nocx-njrx.4, the Solid sidebar build); the Files epic's sidebar.tsx commit `bc498ed`
(2026-08-06, nocx-708q) adds only active-origin plumbing — 25 insertions, 1 deletion, zero
touches to initial-state logic. `createSidebarState` documents the intent outright:
"Create sidebar state with the first view active and panel open" (sidebar-model.ts:34). The
epic did not change it — not a regression. §7's "From a cold start with the panel collapsed"
premise is stale and needs amending (it describes the pre-rp2j sidebar, which opened on
Ports).

The toggle observation is the existing `setActiveView` semantics, documented as VS Code
behaviour (sidebar-model.ts:52-73: "clicking the active view's icon closes the panel"), so
the spec now expresses it: check 1 asserts the real cold start (Files first, enabled,
panel OPEN on Files), check 2 clicks the icon and asserts the collapse, clicks again and
asserts the re-open, then the tree assertions — the "clicking it opens the panel" phrasing
now appears only where it is true.

## Gates

- `npm run lint` — clean (incl. dead-export ratchet; no new export was added)
- `./node_modules/.bin/tsc --noEmit` — clean
- `./node_modules/.bin/vitest run` — 2208 tests, 121 files, all passing
- Acceptance spec (documented recipe) — 4 passed, deterministic across two runs

No commits, no push, no branch, no beads touched. The throwaway probe spec was deleted.
