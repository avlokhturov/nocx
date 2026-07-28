# Vertical tab strip — search, two-line rows, left-aligned text

You are a worker dispatched by a coordinator through Orca orchestration. The lifecycle
instructions (taskId, dispatchId, coordinator handle, `worker_done`) are in the preamble
that delivered this file. Follow them; send a `heartbeat` with `--phase` at every phase
change, and `ask` the coordinator rather than guessing if a decision below is ambiguous.

## Repo and state — read before touching anything

- Repo: `/home/dev/repos/nocx`. **Work in this checkout**, not a copy: `pwd` first.
- `AGENTS.md` is the operating contract. Read it. `docs/architecture.md` holds the binding
  ADs; `.internal/specs/2026-07-27-kit-owns-its-appearance-design.md` holds the kit rules.
- Branch is `fix/dev-web-ports-nocx-z069`, and **the tree has a lot of uncommitted work in
  it** from the current session. Do not stash, reset, revert or commit ANYTHING. Leave the
  working tree with your changes added to what is already there.
- Do not touch `frontend/src/renderers/**` (AD-6) and do not change the terminal font size.

## What the owner asked for

The vertical tab strip should borrow the good ideas from Warp's tab panel — not copy it.
Four items, all scoped to the strip:

1. **Search/filter over the tabs**, in the strip's own header. Typing filters the visible
   tab list. This is the one item that is new behaviour rather than layout.
2. **Two-line rows**: the tab title on the first line and a dim second line under it.
   The second line's content already exists — `Tab.tooltip`, which is the cwd for a local
   tab (`~/repos/nocx`) and `SSH user@host` for an SSH tab. It reaches the strip through
   the display record (`tab-strip.tsx` already stores `tooltip`). Long values must ellipse,
   not wrap.
3. **Text aligned left, VERTICAL ONLY.** The horizontal strip keeps its centred label —
   this is not a global change. `.nocx-tab-label` currently centres with `justify-content`
   and `margin: 0 26px`; in vertical the index pill sits at `left: 10px` and the close
   button at `right: 4px`, so the label's insets have to make room for both without
   centring the text.
4. **Keep the vertical active indicator** — the 2px accent bar on the row's left edge,
   which `tab.css` already draws under `.tabstrip-vertical .nocx-tab[aria-selected='true']
.nocx-tab-indicator`. Warp uses a filled block instead; the owner explicitly chose the
   bar. Do not replace it.

Explicitly NOT in scope, so do not build them: tab groups with headings, the round session
glyph, drag-to-reorder changes, and any change to the horizontal strip's appearance.

## Constraints that will fail review if broken

The kit owns its appearance. These are enforced by `frontend/lint-fixtures/check-css-integrity.mjs`
and by types — run them, do not work around them:

- **A surface never paints a kit identity.** A rule whose subject is a `ui-*` class the kit
  renders may not declare `background`, `border*`, `color`, `font*`, `box-shadow` or
  `padding`. Placement (`display`, `flex`, `gap`, `width`, `margin`, `order`) is allowed.
  If a kit component needs to look different, add a **prop** to the component (see
  `IconButton`'s `size`, which gained an `xs` step today) rather than styling it from
  outside.
- **Kit components refuse `class`** at compile time. Do not try to pass one.
- **Type sizes come from the scale in `tokens.css` and are in `rem`.** A raw `px` font-size
  is a lint violation (`untokenised-type`), and a `px` font-size TOKEN is another
  (`px-font-size-token`). The scale is `--font-size-2xs … --font-size-xl`; the second line
  of a tab row is smaller than the first, so it wants an existing step, not a new number.
- The strip is a component: its classes (`.tabstrip-vertical`, `.tabs-container`,
  `.tabstrip-actions`, `.nocx-tab*`) live in `frontend/src/styles/components/tab-strip.css`
  and `tab.css`. Keep them there; `style.css` holds only the shell hosts and the terminal.
- Search input: use the kit's `SearchField` (`frontend/src/ui/search-field.tsx`), the same
  component the settings rail and the quick-connect palette use. Do not hand-roll an input —
  `nocx/no-raw-controls` will reject it.

## Design decisions already made — implement these, do not re-litigate

- The strip's actions (`+` and the quick-connect caret) are a group, `.tabstrip-actions`, and
  they sit at the TOP of the vertical column (`order: -1`). The search field belongs in that
  same header region — decide whether it sits on its own line above the actions or shares the
  line, and say which you chose and why in your report.
- Row height grows to fit two lines. Existing height is 38px; the e2e suite asserts rows are
  taller than 10px and that they stack downward, so it will not fight you, but check
  `e2e/tabs.spec.ts` and `e2e/vertical-tab-placement.spec.ts` and update any assertion that
  encoded the OLD geometry — as an assertion, not a deletion.
- Filtering hides rows from the list. It must not close, deactivate or reorder tabs, and the
  active tab must stay active even when filtered out of view. Clearing the field restores the
  full list.
- Escape in the search field clears it. If the field is empty, Escape does nothing (the strip
  is not an overlay and must not swallow the key).

## Tests you must write

Unit (vitest, jsdom) in `frontend/src/`:

- filtering by a substring of the title keeps matching rows and drops the rest;
- filtering by a substring of the SECOND line (the cwd/host) matches too;
- clearing the query restores every row;
- filtering does not change which tab is active.

e2e (`e2e/`, Playwright) — extend the existing vertical specs rather than adding a file if
the case fits there:

- with the strip vertical, a row shows both lines and the second line is not empty for a
  local tab;
- the label's text starts at the left, not centred: assert the text box's left edge sits
  close to the row's left content edge, and that the SAME assertion fails in horizontal
  (i.e. the horizontal strip still centres) — one test per orientation.

Every test must be able to fail for the right reason. An assertion that passes on both the
old and the new behaviour is not coverage.

## Verification — all of it, before you report done

    cd /home/dev/repos/nocx/frontend
    npx tsc --noEmit          # REQUIRED even though vitest transpiles without type-checking
    npx eslint .
    npx vitest run
    node lint-fixtures/check-css-integrity.mjs
    node lint-fixtures/check-css-colors.mjs --dir=src
    sh lint-fixtures/gate.sh
    cd /home/dev/repos/nocx && npx prettier --check .

Baseline: all of the above are GREEN right now, and the e2e suite is 146 passed / 4 skipped
across chromium and webkit. Anything red at the end is yours.

For e2e you need your own stand, on ports nobody else holds. **Check `ss -ltnp` first, and
never `pkill -f devharness`** — the owner runs a stand on 9880/5180 and the coordinator one
on 5173/35625; killing either interrupts a live session. Use your own:

    cd /home/dev/repos/nocx && go run ./cmd/devharness      # prints WSPORT= and WSTOKEN=
    cd frontend && npx vite --port 5175 --strictPort        # from frontend/, NOT the repo root
    cd /home/dev/repos/nocx && NOCX_WS_PORT=<port> NOCX_WS_TOKEN=<token> \
      NOCX_BASE_URL=http://localhost:5175 npx playwright test e2e/tabs.spec.ts \
      e2e/vertical-tab-placement.spec.ts --project=chromium --reporter=line

Kill your own stand by PID from `ss -ltnp` when you are done.

## Report

Numbers, not adjectives: what you added, which files, the gate results, the e2e counts, and
every decision you made that the brief left open. List anything you could NOT verify and why
— silence there reads as "nothing to report" and it is the one thing that gets a report
rejected. Do not commit, do not push, do not touch beads.
