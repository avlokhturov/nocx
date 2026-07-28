# Vertical tab strip — seven corrections from the owner, measured on screen

You are a worker dispatched through Orca orchestration. Lifecycle instructions (taskId,
dispatchId, coordinator handle, `worker_done`) are in the preamble that delivered this file.
Send a `heartbeat` with `--phase` at each phase change and `ask` the coordinator rather than
guessing.

## Repo and state

- Repo `/home/dev/repos/nocx`, branch `fix/dev-web-ports-nocx-z069`. **Work in this
  checkout** — `pwd` first. The tree holds a lot of uncommitted work from the live session:
  do not stash, reset, revert or commit anything.
- `AGENTS.md` is the operating contract; `.internal/specs/2026-07-27-kit-owns-its-appearance-design.md`
  holds the kit rules. The previous pass on this strip is described in
  `.internal/briefs/vertical-tabs-warp-ideas.md` — read it, you are correcting its output.
- **Do not touch `frontend/src/terminal-content.ts`.** The coordinator is editing it right
  now (the filter-typing fix, item 8 of the owner's list, already done). Everything below is
  in `tab.tsx`, `tab-strip.tsx`, `tab.css`, `tab-strip.css` and their tests.

## The seven items, in the owner's words, with what each one means

1. **Move `+` and the caret onto the filter row, at its right end.** They are currently a
   second row (`.tabstrip-actions`, `order: -1`) under the search row (`.tabstrip-search`,
   `order: -2`). One header row: the field takes the remaining width, the two buttons sit at
   its right. Keep them one group so the horizontal strip is unaffected — it renders the same
   tree and must keep its current appearance exactly.

2. **The caret glyph is unclear.** It is the literal character `▾` in `tab-strip.tsx`. Replace
   it with a proper chevron icon in the kit's icon set — `frontend/src/ui/icons/`, Lucide
   `chevron-down` under ISC, same shape as `SearchIcon.tsx`/`ResetIcon.tsx` (24×24 viewBox,
   `stroke="currentColor"`, `stroke-width="2"`, `aria-hidden`), exported from the barrel. The
   `+` stays a character for now unless it looks wrong beside a drawn glyph — if you change
   it, change it to a Lucide `plus` in the same style and say so.

3. **`.nocx-tab-title` is smaller in vertical than in horizontal.** It should be the same
   size in both. Find where the vertical strip lowers it (the strip declares
   `font-size: var(--font-size-2xs)` on `.tabstrip-vertical`, which the title inherits unless
   it sets its own) and make the title's size come from one place for both orientations.

4. **The gap after the index pill is smaller than the gap before it.** The pill is absolutely
   positioned at `left: 10px` and the label is offset by `margin: 0 26px`; 10 + 22 = 32 > 26,
   so the text starts 6px INSIDE the pill's right edge rather than clear of it. Make the two
   gaps equal, and derive the label's inset from the pill's geometry rather than from a
   second hand-picked number.

5. **Centre the two lines vertically in the row.** The label block is
   `flex-direction: column` with `padding: 4px 0`; the pair should sit on the row's vertical
   centre, and stay centred when the second line is absent (item 6).

6. **No second line when the tab has no name yet.** A tab's subtitle currently renders
   whatever `tooltip` holds, including the empty string before the session reports its cwd —
   which leaves an empty line that changes the row's height when it fills in. Render the
   subtitle only when there is something to show. The row's height must not change when it
   appears: decide whether the row is fixed-height with the pair centred, or grows — and say
   which you chose.

7. **The second line should be greyer than the first.** It is `--color-text-dim` today and
   the title inherits the strip's colour. Use the token layer, not a new colour: the palette
   has `--color-text`, `--color-text-muted`, `--color-text-dim`. A literal colour is a lint
   violation (`check-css-colors.mjs`) and so is a raw `px` font-size (`untokenised-type`).

Item 8 of the owner's list — "nothing can be typed into the filter, the editor swallows it" —
is FIXED already, in `terminal-content.ts`. Do not redo it and do not touch that file.

## Constraints that fail review if broken

- **A surface never paints a kit identity**: no `background`/`border*`/`color`/`font*`/
  `box-shadow`/`padding` on a `ui-*` class from outside `ui/`. Placement is fine. If a kit
  component must look different, add a **prop** to it (`IconButton` gained `size="xs"` today).
- Kit components refuse `class` at compile time — do not try.
- Type sizes come from the rem scale in `tokens.css`; colours come from the token layer.
- Icons live in `src/ui/icons/` and are exported from `index.ts`.

## Tests

The existing suites already cover the subtitle, the filter and the left alignment
(`frontend/src/tab.test.tsx`, `frontend/src/tab-strip.test.tsx`, `e2e/tabs.spec.ts`). Extend
them:

- the subtitle element is absent when the tooltip is empty, present when it is not;
- the title's computed font-size is the same in both orientations (an e2e measurement, since
  it is inherited — a unit test on the class cannot see it);
- the row's height does not change when a subtitle appears (measure, do not assume).

An assertion that passes on both the old and the new behaviour is not coverage. Check that
each new test fails when you revert the change it covers — and say in your report that you
did, or that you could not and why.

## Verification — all of it

    cd /home/dev/repos/nocx/frontend
    npx tsc --noEmit
    npx eslint .
    npx vitest run            # baseline: 866 passed. A LOWER number means a suite stopped
                              # loading — check `Test Files`, not just `Tests`.
    node lint-fixtures/check-css-integrity.mjs
    node lint-fixtures/check-css-colors.mjs --dir=src
    sh lint-fixtures/gate.sh
    cd /home/dev/repos/nocx && npx prettier --check .

e2e baseline is 152 passed / 4 skipped across chromium and webkit. Run at least chromium for
`e2e/tabs.spec.ts` and `e2e/vertical-tab-placement.spec.ts`. Your own stand, on ports nobody
holds — check `ss -ltnp` first and **never `pkill -f devharness`** (the owner runs 9880/5180,
the coordinator 5173/35625):

    cd /home/dev/repos/nocx && go run ./cmd/devharness       # prints WSPORT= and WSTOKEN=
    cd frontend && npx vite --port 5176 --strictPort         # from frontend/, NOT the repo root
    cd /home/dev/repos/nocx && NOCX_WS_PORT=<port> NOCX_WS_TOKEN=<token> \
      NOCX_BASE_URL=http://localhost:5176 npx playwright test e2e/tabs.spec.ts \
      e2e/vertical-tab-placement.spec.ts --project=chromium --reporter=line

Kill your stand by PID when done.

## Report

Numbers, not adjectives. For each of the seven items: what you changed and the measurement
that says it worked (a size in px, a gap in px, a computed colour). Every decision the brief
left to you, named. Everything you could not verify, named — silence there is what gets a
report rejected. No commits, no pushes, no beads.
