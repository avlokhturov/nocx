# nocx-u7wq.6 — 27 buttons render as the platform's own chrome

**Bead:** `nocx-u7wq.6` (P1 bug). Read it first — `bd show nocx-u7wq.6`. It contains the
root cause and the audit command; this brief adds the boundaries and the trap.

## The defect a user sees

A `<Button>` with neither a `variant` nor a `class` emits a bare `<button>` and renders as
the operating system's button — light grey fill, system focus ring, ignoring the theme —
on a dark surface. `VARIANT_CLASS.default` is the empty string in `frontend/src/ui/button.tsx`.

## The trap — read this before you touch button.tsx

**Do not "fix" it by giving `default` a base class.** That pushes background, border and
height underneath all 27 call sites, including the ones that pass a fully formed class of
their own (`.tab-add`, `.tab-close`, `.cm-save`, the activity-bar buttons) whose CSS was
written on the assumption of a bare element. Those sites are **correct today** and a base
class silently repaints them. This is a per-caller audit, not a one-line change. The bead
says so; it is the whole reason the bug is still open.

## The boundaries — what they already decided

- **`frontend/src/ui/README.md`** — read it and list `frontend/src/ui/` before you add
  anything. A surface may **place** a kit component (flex, margin, width, order,
  align-self, position) and may never **repaint** it (background, border, color, font-\*,
  padding, box-shadow). Wanting to repaint means the component is missing a variant — add
  the variant to the kit, do not fork it into the surface.
- **ADR-0014** (component kit foundation) and **ADR-0013** (plain CSS with semantic custom
  properties). No raw colour literals; the CSS colour and integrity lint gates enforce it.
- A real `secondary` variant already exists (`.ui-btn-secondary`) and Settings' Reset
  already uses it. Part of this work is done; do not redo it.

## What to do

1. Run the audit and enumerate every site:
   `grep -rn "<Button" frontend/src --include=*.tsx | grep -v test | grep -v "variant=" | grep -v "class="`
2. For **each** site, decide one of two things and record which in the commit body:
   - it wants a kit variant (`primary`, `secondary`, `danger`, …) → give it the variant;
   - it is a genuinely bespoke surface control with its own complete CSS → give it its
     class and leave it bare, and say in a comment why it is bare.
3. If a site wants something the kit does not have, **add the variance to the kit** as a
   typed variant with its own CSS in `styles/components/`, a stable identity class, a test
   and a row in the README table. Never a near-duplicate, never a hand-rolled `<div>`.
4. Decide deliberately what `default` should mean once no caller relies on it being empty.
   If it becomes a real class, say in the commit body why that is now safe — i.e. that you
   checked every remaining caller. If it stays empty, say why.
5. `.ui-settings-reset-btn` has no CSS either — clean up any other class that is referenced
   and undefined while you are in there, or file it if it is out of reach.

## Acceptance — as assertions

- The audit command returns **zero** sites that are neither varianted nor classed, or every
  remaining one carries a comment saying why it is deliberately bare.
- A test asserts a defaulted `<Button>` carries a kit identity class — the kind of test that
  would have failed before this change.
- No existing button changes appearance. Prove it: the sites that pass their own class
  render with the same computed background and border as before.
- `npm run lint` passes, including the CSS colour and integrity gates and the kit-identity
  fixture gate.

## Out of scope

Anything that is not a `<Button>`. Do not restyle surfaces, do not rework Settings, do not
touch the ports panel or quick connect — other workers are in those files right now.

## Working rules

TDD. Full frontend gate before you report: `npx prettier --check .`, `npx eslint .`,
`npm run typecheck`, `npm test`. Commit message carries `(nocx-u7wq.6)`. Report a blocker
as an `orca orchestration ask` the same minute you hit it.
