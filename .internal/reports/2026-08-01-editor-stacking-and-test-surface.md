# Editor stacking and test-surface probe — 2026-08-01

Investigation only; no behaviour changed, no dependencies added. Worktree:
`cm6-stacking-probe`. Task `task_5ea780261aa4` (dispatch `ctx_47a049ba11e6`),
run `run_85b0e301b044`. Companion to ADR `0010-codemirror-6-as-the-editor-core.md`
consequences (tracked as `nocx-0oc` and `nocx-6qx`).

Verification limits up front: this worktree has **no `node_modules`** and no built
Go binary, so nothing here was reproduced in a running browser. Every claim below
is static evidence — CSS rules, xterm.js 5.5.0 sources fetched from the upstream
repo at tag `5.5.0`, and DOM-construction order read from the app code. Claims
that would need a live run are marked **[UNVERIFIED]**.

---

## Question 1 — what actually stacks `.nocx-editor` above `.xterm-link-layer`

### Short answer

**Nothing stacks it.** The editor is not held above the link layer by any stacking
rule today; it is protected by **geometry** — the link-layer canvas lives inside a
clipped, height-bounded live region that is a different flex row from the editor,
so the two never overlap in any state where the editor is visible. The
`z-index: 20` invariant written down in ADR-0010 is not enforced anywhere; it is a
fossil of the pre-DOM-scrollback layout (nocx-4ff.16 era), when the editor floated
over a full-pane xterm and the canvas could actually win hit-testing over it.

### Evidence

1. **`.nocx-editor` has no `z-index`.** `frontend/src/style.css:102-109`:
   `position: relative; flex: none; background: …; border-top: …; border-left: …;
padding: …`. No `z-index` property. The file's **only** z-index value is
   `.cmd-overflow-menu { z-index: 200 }` at `style.css:500-501`. There is no
   `z-index: 20` anywhere in the stylesheet, not even in comments — the
   `style.css:1086-1087` line numbers in `nocx-0oc` refer to an earlier revision
   of the file (it is 528 lines today).
2. **No ancestor between the editor and the viewport root creates a stacking
   context.** The chain, read from `frontend/src/styles/base.css` and
   `frontend/src/style.css`:
   - `.pane` — `position: absolute; inset: 0; overflow: hidden; display: flex;
flex-direction: column; padding: 0 10px` (`base.css:332-343`). Positioned
     with `z-index: auto` → **not** a stacking context. **This is the key
     negative.**
   - `#panes` — `position: relative`, no z-index (`base.css:325-330`) → not a
     stacking context.
   - `#app`, `body`, `html` — no `position`/`transform`/`filter`/`opacity`/
     `will-change`/`isolation`/`contain` anywhere in the app CSS or the theme CSS.
     A recursive grep of `frontend/src/styles/` for
     `transform|filter:|opacity|will-change|isolation|contain:|mix-blend|backdrop-filter`
     matched only component-local rules (buttons, checkbox/tab pseudo-elements,
     prompt/toast animations) — nothing on the app shell chain.
   - `.scrollback-layout`, `.scrollback-area`, `.scrollback-inner`,
     `.xterm-live-container`, `.xterm-inner` — all static, none of them stacking
     contexts (`style.css:236-263, 275-319`).
3. **The link layer's z-index is real but trapped nowhere — it escapes to the
   root context, where it outranks the editor.** The app's primary renderer is
   `@xterm/addon-webgl` (`frontend/src/renderers/xterm.ts:1-3`; WebGL → Canvas →
   DOM fallbacks). In addon-webgl 5.5.0, `WebglRenderer.ts:85` constructs
   `LinkRenderLayer(this._core.screenElement!, 2, …)` — the link canvas is a
   child of `.xterm-screen` with **inline `z-index: 2`**. `.xterm-screen` is
   `position: relative` with no z-index (`xterm.css` 5.5.0), so it does **not**
   trap the canvas. `.xterm` root and `.xterm-viewport` are also z-index-less.
   Result: the link canvas's `z-index: 2` participates in the nearest real
   stacking context (effectively the root), where `.nocx-editor`'s positioned
   `z-index: auto` paints at step 6 of the paint order (effective 0). **If the
   two overlapped, the link canvas would win** — which is exactly the dead-mouse
   bug nocx-4ff.16 fixed.
4. **The two never overlap.** DOM construction:
   - `ScrollbackController` builds `.scrollback-layout > .scrollback-area >
.scrollback-inner > [.cmd-block…, .xterm-live-container > .xterm-inner]`
     and inserts it as the pane's **first child**
     (`frontend/src/scrollback/controller.ts:52-86`, `insertBefore` at :86).
   - `CommandEditor.mount(target)` appends `.nocx-editor` to the pane **after**
     it (`frontend/src/terminal-content.ts:273`) — the editor is the last flex
     item of the pane column.
   - `.xterm-live-container` clips everything: `overflow: hidden`
     (`style.css:275-282`), `height: 0` when idle (`:284-286`), `height: 140px`
     when running (`:288-290`), inline height bounded by
     `scrollbackArea.clientHeight` in fullscreen/unstructured modes
     (`controller.ts:177-178, 274-275`). In every mode it stays _inside_ the
     `.scrollback-area` flex row, which is _above_ the editor row in the pane
     column. The link canvas therefore never covers the editor's rectangle.
   - The editor is hidden in exactly the states where the live region has
     height: `editor.hide()` on RUNNING_RAW (`terminal-content.ts:331`),
     markerless/raw (`:336`), and native mode (`:628`). When the editor is
     visible (idle prompt), the live container is `height: 0`.
   - The e2e hit-test `e2e/command-editor.spec.ts:26-37` (elementFromPoint at the
     textarea centre must be `TEXTAREA`) therefore passes **because nothing
     paints over the textarea**, not because the editor outranks the canvas.
     **[UNVERIFIED]** — I could not run it; the pass is derived from the static
     geometry above.
5. **The `z-index: 20` comments are all stale.** The only places the value
   survives: `e2e/command-editor.spec.ts:23`, `.internal/specs/
2026-07-25-editor-core-codemirror6-design.md`, and
   `docs/decisions/0010-codemirror-6-as-the-editor-core.md`. The stylesheet
   itself no longer mentions it. The punch-list that supposedly added it
   (nocx-4ff.16: ".xterm-link-layer canvas (z-index:2) won hit-testing over the
   DOM editor (z-index:auto). Fix: .nocx-ed…") predates the DOM-scrollback
   redesign (ADR-0008/4ff.25) that replaced the full-pane xterm with the clipped
   live region; the rule either never landed or was dropped in the redesign, and
   the geometry change made the omission invisible.

### Deliberate or accidental?

**Accidental.** No rule enforces the invariant; it holds because of the layout
redesign's clipping, which was designed for rendering (clip xterm artifacts,
P1-5) and for pane-filling programs (nocx-6w4z), not for the editor's hit-testing.
The written invariant (`z-index: 20`) describes a mechanism that does not exist.

### Would a CM6 swap change the answer?

**No — for the hit-testing invariant.** Replacing the `<textarea>` inside the
card with `.cm-editor > .cm-scroller > .cm-content` changes nothing about the
card's own box: `.nocx-editor` keeps `position: relative` (the rule is at
`style.css:103` and survives untouched), stays the last flex item of the pane
column, and the live region stays clipped. CM6's own CSS adds no stacking context
on the chain (`.cm-editor` is `position: relative` z-index auto; `.cm-scroller`
is an ordinary scroll container; `.cm-content` in-flow) — and even if CM6 created
contexts _inside_ the card, they would be below the card's box and irrelevant to
whether anything paints over the card. The other worker does **not** need to
replicate `z-index: 20` to keep the mouse working today.

**The risk is different:** the invariant is load-bearing _as written_ for the
future, not for today. Any layout change that lets the live region overlap the
editor (a future overlay-style prompt, an undocked editor, fullscreen editor
chrome) resurrects the dead-mouse bug, because nothing enforces the paint order.
The CM6 swap is the right moment to write the rule down so the invariant stops
depending on an accident.

### Minimal explicit rule (shown, not applied)

```diff
 .nocx-editor {
   position: relative;
+  z-index: 20;
   flex: none;
   background: var(--color-canvas);
```

What it would break — **one real collision, one benign**:

- **`.ui-prompt-overlay` (z-index: 1, `position: fixed; inset: 0`, prompt.css:1-12)
  would drop below the editor.** Today the scrim paints above the editor
  (auto ≈ 0 < 1) and captures clicks for light-dismiss. With the editor at
  z-index 20, the editor would paint **above** the scrim — the editor row would
  be undimmed behind a password prompt and clicks there would miss the scrim's
  light-dismiss handler. This is the SSH-password-while-a-terminal-tab-is-open
  path (`prompt.tsx:55`). **[UNVERIFIED]** — the scrim's click handling is
  asserted by `prompt.test.tsx` in jsdom, which cannot see paint order. Needs a
  browser check after the rule lands.
- **Gutter (`z-index: 10`, `pointer-events: none`, `gutter.ts:94-97`)**: benign —
  the gutter's glyphs sit at `left: 0`, `width: 3px` inside a 16px strip
  (`GUTTER_WIDTH_PX = 16`, `gutter.ts:9`), while the editor's box starts at the
  pane's 10px padding edge; the overlap region is the gutter's empty strip, and
  `pointer-events: none` makes hit-testing moot either way.
- Everything else above 20 is unaffected: `.cmd-overflow-menu` 200,
  `.ui-toast-host` 300, native dialogs (top layer).

If the rule is added, the scrim's z-index (or the editor's) needs the collision
resolved deliberately — e.g. raising the prompt overlay above 20, or confirming
the editor-under-scrim paint is desired.

---

## Question 2 — vitest browser mode

### What the test surface is today

**Unit (vitest, `frontend/vitest.config.ts`):** default `environment: 'node'`
(deliberately — 539 tests touch no DOM), Solid/component tests opt into jsdom
per-file via `// @vitest-environment jsdom` pragma; 56 test files currently use
the pragma. `jsdom ^29.1.1` is a devDependency; `vitest.setup.ts` polyfills
`ResizeObserver` with a never-firing stub and `HTMLDialogElement.showModal`. Test
script: `npm test` → `vitest run`. CI (`ci.yml` frontend job, ubuntu, node 24):
`npm ci → format:check → lint → typecheck → npm test → build`. The setup is
explicitly jsdom-shaped: the ResizeObserver stub comment says "enough for unit
tests that don't depend on layout".

**E2E (Playwright, root package: `@playwright/test 1.61.1`):** 25+ specs in
`e2e/`, chromium **and** webkit projects, two modes — real `wails dev` app, or
headless (`NOCX_WS_PORT` set: Go `devharness` backend + vite dev server, no
wails/GTK). CI e2e job: macos-latest, `npx playwright install chromium webkit`,
`npx playwright test`, 20-minute timeout. The config's own rationale
(`playwright.config.ts:3-6`): "That is the only place layout, focus and GPU
behaviour are observable — jsdom has none of them." The suite already owns
measurement-dependent behaviour: `e2e/grid-width.spec.ts` measures the fitted
grid against the scroller and documents (in its header comment) that the overhang
differs **per engine** — 20px Chromium vs 10px WKWebView for the same build
because `scrollbar-gutter: stable` is ignored by WebKit — and that "a jsdom test
cannot see any of it". The CM6 epic itself (nocx-6qx, EDITOR-W5) already plans to
rewrite the editor assertions _in e2e_: `command-editor.spec.ts` hit-testing,
`clipboard.spec.ts:147`, `click-focus.spec.ts:37-45`, and to add the repo's first
IME composition coverage there.

### What adopting vitest browser mode would cost

- **New dependencies** (frontend/package.json + lockfile): `@vitest/browser`
  pinned to the vitest 3.2.x line, plus a provider — `playwright` (the plain
  package, distinct from the root's `@playwright/test`) or `webdriverio`.
- **CI impact** (frontend job, ubuntu): browser mode spawns a real browser per
  run, so the job gains a browser-install step (`npx playwright install
chromium` or the provider equivalent) and a slower, flake-prone test leg. The
  e2e job's install is separate (macos, both engines), so this is a **second**
  browser download in CI, not a reuse.
- **Existing tests:** the 539 node tests and 56 jsdom-pragma files would not
  change _if_ browser mode is isolated in its own project/config — but that
  isolation is itself the cost: a second config (or `projects` split), a separate
  include glob, and a new `test:browser` script. Browser-mode files cannot use
  the jsdom pragma machinery, and the Solid/testing-library component tests would
  stay on jsdom regardless (they are DOM-shape tests, not layout tests).
- **Coexistence** is technically possible (node+jsdom project and browser project
  in one vitest config, or two configs) — nothing forces a migration. The
  question is only whether the new harness is worth its surface.

### The alternative: the Playwright e2e suite is already the measurement home

- **What is already there:** real layout in real browsers, both engines; the
  headless mode (devharness + vite) makes frontend-focused specs cheap without
  wails/GTK; `grid-width.spec.ts` proves the suite already tests
  measurement-dependent invariants and documents why they cannot live in jsdom;
  W5 already designates e2e for the CM6 swap's assertions and the first IME
  coverage.
- **Is it sufficient?** For the concrete CM6 behaviours named — caret
  coordinates, popup placement, wrapping — yes. They are all observable through
  the page (elementFromPoint, getBoundingClientRect, scroll offsets, selection),
  and the headless mode runs them against vite alone. The honest limits: each
  spec boots the app, so a _large_ volume of measurement tests (dozens) pays a
  per-test boot cost; and caret-level precision tests are more awkward to write
  through a page than against a component.

### Recommendation

**Do not adopt vitest browser mode now. Put the CM6 measurement-dependent
assertions in the existing Playwright e2e suite (headless mode), one spec per
measured behaviour, and keep node/jsdom for everything else.**

Reasons, in order of weight:

1. **The repo's own precedent is engine-divergent measurement.** The one
   measurement bug this repo actually shipped (grid-width overhang) differs
   between Chromium and WebKit, and the e2e suite runs both. Vitest browser mode
   would observe only Chromium (playwright provider) — a third layout harness
   that cannot see the class of bug this codebase has already had, while adding
   its own config, deps, CI step and flake surface.
2. **The e2e home already exists and is already the plan.** W5 (nocx-6qx) rewrites
   the editor assertions in e2e and adds IME coverage there. Adding vitest
   browser mode on top creates two layout-observing harnesses with different
   browser matrices for the same behaviours — a duplication tax, not a gap fill.
3. **Browser mode's real advantage — fast per-test layout in a unit context —
   is not worth it at this volume.** The named behaviours are a handful. When the
   CM6 work grows measurement tests past what e2e round-trips comfortably (ghost
   text, per-character caret math, wrapping edge cases in quantity), that is the
   moment to reconsider; the cost estimate above is then the checklist.

The decision in W5's spec ("forces the nocx-foz decision rather than leaving it
implicit") should therefore land as: **e2e owns measurement; vitest stays
node/jsdom** — with this report as the rationale.

---

## What could not be determined

- Whether the e2e hit-test (`command-editor.spec.ts:26-37`) currently passes.
  No `node_modules`, no backend build in this worktree; the pass follows from
  static geometry, not observation. **[UNVERIFIED]**
- The prompt-scrim collision under the proposed rule (`z-index: 20` vs
  `.ui-prompt-overlay` z-index 1) — paint order only exists in a real browser.
- The link canvas's exact inline z-index on the _installed_ addon (fetched from
  upstream tag 5.5.0 rather than from a local install; `frontend/package.json`
  pins `@xterm/addon-webgl ^0.18.0`, which matches the 5.5.0 line).
