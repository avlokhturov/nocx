# Worker brief — TABS-3: the vertical tab panel, Warp-style (bead `nocx-d3q.3`)

## Why you come before the setting

`nocx-d3q.2` adds a persisted setting that chooses between horizontal and vertical placement. It is
**deliberately scheduled after you**, because a setting that selects between two implementations
needs both to exist — otherwise it is a choice with one option. So your job is the second
implementation; wiring the switch is not yours.

## What already exists — build against it, do not reshape it

The placement port landed earlier and is the whole point of this task being cheap:

- `frontend/src/tab-strip.ts` holds the port and `HorizontalTabStrip`, the first implementation.
- The port is a **push model**: `addTab` / `removeTab` / `reorder` / `setActive` push state in;
  intents (`activate`, `close`, `new-tab`, `reorder`) push events out. `TabManager` owns the ordered
  tab model and consumes intents; `Tab` is state and lifecycle and does **not** own tab-button DOM.
- Keyboard and ARIA already live in the port for the horizontal case: roving `tabindex`, Left/Right,
  Home/End, `focus-visible`, and a stable tab↔tabpanel relationship.

**If you find yourself needing to change the port's interface, stop and escalate with your
reasoning.** The port was extracted specifically so a second placement would not reopen it; if it
must be reopened, that is a design finding worth reporting, not a change to make quietly.

## What to build

A `VerticalTabStrip` implementing the same port, rendering tabs as a vertical list.

- **Keyboard axis flips:** Up/Down move between tabs in vertical placement, where Left/Right do in
  horizontal. Home/End still go to first/last. Roving `tabindex` unchanged. Do not lose
  `focus-visible`.
- **Drag-reorder** should work on the vertical axis. If the existing implementation's drag logic is
  axis-specific in a way that does not generalise, say so rather than half-porting it.
- **The tab strip is also the window's title bar on macOS** in horizontal placement
  (`mac.TitleBarHiddenInset`, hence `.tabbar`'s left padding of 78px for the traffic lights, and
  `--wails-draggable: drag`). A vertical strip cannot serve that role — the traffic lights are
  horizontal. Work out what the window chrome does in vertical placement and **state your answer**;
  this is the non-obvious part of the task and the reason it is more than a CSS exercise. Read the
  `.tabbar` comment block in `style.css` before deciding.

## Reference, not template

Orca's vertical list (the app you are running inside) groups tabs and shows a per-group MRU. We
already adopted MRU activation on close. Grouping is **out of scope** — do not build it.

Warp's vertical mode puts Settings under a separate group heading. Also out of scope, and filed
separately.

## Files you own

`frontend/src/tab-strip.ts` (add the vertical implementation; leave the horizontal one alone),
`frontend/src/tab-strip.test.ts`, `frontend/src/tabs.ts` only if the port genuinely requires it,
`frontend/src/style.css`, and any new test-support fixtures.

You have your own worktree, cut from the integrated tree. Another worker is building the export
surface elsewhere and owns `internal/**`, `frontend/src/settings*.ts` and — note — also
`frontend/src/style.css` **on its own branch**. Both of you adding to the same stylesheet is
expected and additive; keep your rules grouped in one contiguous block with a comment naming the
feature, so the merge is a clean insertion rather than an interleave.

## Verification — you have this worktree to yourself, so run all of it

```bash
cd frontend && npm ci
npm run format:check && npm run lint && npm run typecheck && npm run test
cd .. && gofumpt -l . && golangci-lint run ./... && go test -race -count=1 ./...
```

The existing `tab-strip.test.ts` runs with **zero terminal machinery** — that layer exists precisely
so a placement implementation can be tested in isolation. Add your tests there, in the same style.

Playwright is red on `main`, is not in the per-commit gate, and another worker owns it. Do not run
it, do not chase it, do not claim anything about it. `nocx-d3q.4` covers e2e for both placements and
is not yours.

While you are in `style.css`: the integration merge already produced one exactly-duplicated selector
(`.st-search`, used by two sides for different elements, which would have double-bordered the search
field). Check for duplicated selectors in what you add — neither `tsc` nor the tests can see that.

## Ground rules

- **Do not commit, push or branch.** The coordinator owns git.
- **Do not touch the issue tracker.** No `bd` commands.
- **If you finish early, STOP and report.** Do not implement the placement setting — that is
  `nocx-d3q.2` and it comes after you.
- Format only the files you changed.
- Report numbers, not adjectives: test count before and after, and how many tests run without
  terminal machinery.
- **State explicitly anything you could not verify** — jsdom cannot exercise real layout or native
  drag behaviour, so say what you asserted instead, and give your answer on the window-chrome
  question above.
