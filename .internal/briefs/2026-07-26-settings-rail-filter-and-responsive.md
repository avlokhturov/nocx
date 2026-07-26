# Worker brief — the Settings rail: modified-only filter and a narrow-viewport layout

Two beads, one surface: **`nocx-wbtv`** then **`nocx-v98h`**. Do them in that order — the filter is
small and the responsive work touches the same rules.

## Bead 1 — `nocx-wbtv`: surface the modified-only filter in the rail

The filter logic **already exists** in `SettingsViewImpl` and works: `frontend/src/settings.ts` holds
`modifiedOnly`, filters on `this.overridden.has(d.key)`, and `overridden` is populated from the
snapshot (`settings.getSnapshot` returns `{ values, overridden, revision }`). A filter bar is
rendered by `renderFilterBar()`.

What is missing is the **tab's rail**. When `SettingsContent` was built, its branch did not yet have
`overridden` — it was cut from `origin/main` while the field lived on the settings branch — so the
worker correctly deferred the filter and said so. The branches are now integrated, so the field is
there and the work is unblocked.

Required shape, and this part is not negotiable because it was argued out during design:

- **Customized/Default comes from PROVENANCE**, i.e. presence of the key in the `overridden` set —
  **never** from comparing the value to the default. An explicit override that happens to equal the
  current default is still customization, because it pins the value against future default changes.
  That distinction is exactly what export/import depends on.
- **Secret rows never claim modification.** They have no default; their state is
  Configured / Not configured.
- The rail carries the **toggle plus a live count**, and per-section counts. All derived from the
  snapshot — no frontend list of keys anywhere. If you find yourself writing a setting key as a
  string literal in TypeScript, stop: the screen is generated from declarations and that invariant
  is binding.

Decide deliberately whether the rail drives `SettingsViewImpl`'s existing `modifiedOnly` state or
owns its own, and say which and why. Two owners of one truth is the failure mode this codebase keeps
getting bitten by — do not create a third.

## Bead 2 — `nocx-v98h`: the narrow-viewport layout is missing entirely

This is the original defect class reappearing, not a cosmetic gap. Measured on your base:

- the only `@media` rules in `frontend/src/style.css` are `prefers-reduced-motion`;
- `.st-rail` is `flex: 0 0 clamp(240px, 28vw, 360px)` — a **hard floor of 240px**;
- `.st-label-col` is still `flex: 0 0 200px`, fixed, no shrink.

So at roughly a 500px window the rail takes 240px and the content column gets about 260px minus
padding, where a 200px non-shrinking label column plus a control squeezes. **That is the same
arithmetic that produced the reported bug** — settings used to live in a 240px sidebar panel whose
192px of content width could not hold a 200px column, so the control was pushed out and clipped by
`overflow: hidden`.

Required, per Part C of the design spec
(`.internal/specs/2026-07-26-tab-and-settings-foundation-design.md`):

- The layout is **width-responsive, never content-count-responsive.** Do not make the rail appear or
  disappear based on how many sections are declared — that was explicitly rejected, because it
  creates a transient mode that rots once more declarations land.
- Below the breakpoint the rail collapses to a category picker or a search-first overlay, and the
  content column takes the full width.
- The breakpoint is chosen by **whether both columns remain usable**, not by copying a reference
  screenshot's dimensions.
- Reconsider `.st-label-col: flex: 0 0 200px` while you are here. A fixed no-shrink column is what
  made the original failure possible. Either let it shrink, or stack the row below the breakpoint.
  Say which you chose.

## Evidence, and being honest about it

**jsdom cannot exercise real layout.** You cannot prove this fix with a unit test, and you must not
pretend otherwise. What you can do:

- assert the contract you can reach (classes applied, structure present, computed styles jsdom does
  model);
- and then state plainly in your report that the actual overflow behaviour is **unverified by
  automated tests**, and say what you did instead — for example reasoning through the arithmetic at
  specific widths, or a manual check if you have a way to run the app.

A claim that the responsive layout "works" without evidence will be rejected. Saying "I could not
verify this and here is why" is the correct answer and costs you nothing.

## Files you own

`frontend/src/settings-content.ts` and its test, `frontend/src/style.css`.

**Another worker is active in this same worktree**, owning `frontend/src/tabs.ts`,
`frontend/src/tabs.test.ts` and `frontend/src/test-support/tabs-fixtures.ts`. Do **not** touch those.
Also do not touch `frontend/src/settings.ts` unless the filter genuinely requires it — if it does,
keep the change minimal and name it in your report; that file was rewritten twice already and is the
one that conflicted during integration.

## Verification — scoped, because you are sharing a worktree

**Do not run repo-wide gates.** You would observe the neighbour's half-written `tabs.ts` and report
a phantom blocker.

```bash
cd frontend
npx tsc --noEmit 2>&1 | grep -E 'settings-content|style\.css|settings\.ts'
npx eslint src/settings-content.ts
npx prettier --check src/settings-content.ts src/style.css
npx vitest run src/settings-content.test.ts src/settings.test.ts
```

Say plainly that a whole-project typecheck was **not** run and why. The coordinator runs the full
gate afterwards.

While you are in `style.css`, one warning from experience: the integration merge left an
exactly-duplicated `.st-search` selector, because two sides used the same class name for different
elements — one for the wrapper, one for the input — which would have double-bordered the search
field. It is fixed, but **check for duplicated selectors in anything you add**, because neither
`tsc` nor the test suite can see that class of defect.

Playwright is red on `main`, is not in the per-commit gate, and a separate worker owns it right now.
Do not run it, do not chase it, do not claim anything about it.

## Ground rules

- **Do not commit, push or branch.** The coordinator owns git.
- **Do not touch the issue tracker.** No `bd` commands.
- **If you finish early, STOP and report.** Do not start adjacent work — the `SettingsContent`
  integration tests are a separate filed bead and are deliberately not yours.
- Format only the files you changed.
- Report numbers, not adjectives.
- **State explicitly anything you could not verify**, and expect the layout to be on that list.
