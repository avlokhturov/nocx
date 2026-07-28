# Two kit gaps: vertical rhythm (nocx-g470), then button variants (nocx-3q8t)

You are a worker dispatched through Orca orchestration. Lifecycle instructions (taskId,
dispatchId, coordinator handle, `worker_done`) are in the preamble that delivered this file.
Send a `heartbeat` with `--phase` at every phase change. **Use `ask` rather than guessing**
on the two design decisions marked below — the coordinator is at the keyboard and answers.

## Repo and state

- Repo `/home/dev/repos/nocx`, branch `fix/dev-web-ports-nocx-z069`. **Work in this
  checkout** — `pwd` first. The tree holds uncommitted work from a live session: do not
  stash, reset, revert or commit anything.
- `AGENTS.md` is the operating contract. `.internal/specs/2026-07-27-kit-owns-its-appearance-design.md`
  is the kit's design; read §3 and §4 before adding a primitive.
- Read both beads first: `bd show nocx-g470` and `bd show nocx-3q8t`. Their acceptance
  criteria are the definition of done. **Do not touch beads** — the coordinator owns them.

### Files that are NOT yours

The coordinator is editing the tab strip right now. Do not open, and do not let a sweep
touch: `frontend/src/tab.tsx`, `frontend/src/tab-strip.tsx`, `frontend/src/tabs.ts`,
`frontend/src/terminal-content.ts`, `frontend/src/styles/components/tab.css`,
`frontend/src/styles/components/tab-strip.css`. If one of them genuinely needs the new
primitive, say so in your report and leave it alone.

## Task 1 first: nocx-g470 — the kit has no vertical rhythm

The kit gives a vocabulary — Button, TextField, Checkbox, FileInput, Field, Section — and no
grammar for stacking. `Field` spaces a label from its control; nothing spaces two controls
from each other, so every surface improvises margins and where it forgets, controls touch.

Measured, and this is the reproduction: `frontend/src/styles/surfaces/export.css` declares
`.st-export-import-section { margin-bottom: 16px }` and `.st-export-import-label
{ margin-bottom: 4px }` — nothing between the FileInput, the passphrase TextField and the
"Decrypt and Import" Button, which render flush against each other on the
Export / Backup / Import page.

**ASK THE COORDINATOR before implementing** which of these the rhythm belongs to, with your
recommendation and its reasoning:

1. a new `Stack` primitive in `src/ui/` with a `gap` prop from the space scale;
2. `Field`, since every control already sits in one;
3. `Section`/`PageSection`'s content slot, so a group spaces its own children.

Whichever is chosen:

- The gap comes from the space scale (`--space-*`), never a literal number.
- **The Export page's import blocks must become visibly spaced WITHOUT `export.css` gaining
  a margin.** If you find yourself adding one, the primitive is not carrying its weight.
- Sweep the surfaces that improvised margins between kit controls onto the primitive. Name
  in your report every one you swept and every one you left, with the reason.
- Add the lint rule the bead asks for: a surface must not space kit components by hand.
  It belongs in `frontend/lint-fixtures/check-css-integrity.mjs` beside rule 3
  (`surface-paints-kit`), which already knows how to tell a kit identity from a surface's
  own class. Every rule there has a negative fixture in `lint-fixtures/css-integrity-fixture/`
  and an assertion in `lint-fixtures/gate.sh` that proves it FIRES — add both, in both
  directions (a surface spacing its OWN elements must stay silent). If you conclude the rule
  cannot be written without false positives, say so with the case that defeats it — that is
  an acceptable answer, silence is not.

## Task 2 after it: nocx-3q8t — button variants have no rule

`Button` offers `default`, `primary`, `danger`, `ghost`, and nothing says when to use which.
Counted: default 11, primary 6, danger 3, ghost 1. On the Export page "Export Configuration"
is `default` while "Encrypt and Export" is `primary`, though each is the main action of its
own section — the owner read them as two different kinds of button.

The rule to write down, unless you can argue a better one:

- **primary** — the one action a section exists for. At most one per section.
- **default** — everything else that is a real action.
- **danger** — destructive and irreversible.
- **ghost** — a control that reads as a row rather than a button (the settings rail's nav).

Then sweep the call sites to match it. A call site that deliberately does not match keeps a
comment saying why. Write the rule where a developer will meet it: `button.tsx`'s doc comment
and `src/ui/README.md` next to Button — not in a document nobody opens.

**ASK THE COORDINATOR** before changing any button whose variant change is user-visible on a
screen the owner has been reviewing today (Settings rows, the quick-connect palette, the
Connections page). List them and propose; do not decide alone.

## Constraints

- A surface never paints a kit identity: no `background`/`border*`/`color`/`font*`/
  `box-shadow`/`padding` on a `ui-*` class from outside `ui/`. Customisation is a **prop**.
- Kit components refuse `class` at compile time.
- Type sizes come from the rem scale in `tokens.css`; colours from the token layer.
- No compatibility shims, no dead code (AGENTS.md "clean-only").

## Verification

    cd /home/dev/repos/nocx/frontend
    npx tsc --noEmit          # REQUIRED — vitest transpiles without type-checking
    npx eslint .
    npx vitest run            # baseline 869 passed / 62 files. A LOWER file count means a
                              # suite stopped loading — check `Test Files`, not just `Tests`.
    node lint-fixtures/check-css-integrity.mjs
    node lint-fixtures/check-css-colors.mjs --dir=src
    sh lint-fixtures/gate.sh
    cd /home/dev/repos/nocx && npx prettier --check .

New unit tests for the primitive (it is a kit component: it gets its own `*.test.tsx` like
every other one, asserting the gap comes from the token and that it refuses `class`).

e2e: your own stand, ports nobody holds — check `ss -ltnp` first and **never
`pkill -f devharness`** (the owner runs 9880/5180, the coordinator 5173/35625):

    cd /home/dev/repos/nocx && go run ./cmd/devharness      # prints WSPORT= and WSTOKEN=
    cd frontend && npx vite --port 5177 --strictPort        # from frontend/, NOT the repo root
    cd /home/dev/repos/nocx && NOCX_WS_PORT=<port> NOCX_WS_TOKEN=<token> \
      NOCX_BASE_URL=http://localhost:5177 npx playwright test --project=chromium --reporter=line

Kill your stand by PID when done. e2e baseline is 156 passed / 4 skipped across both engines;
chromium alone is enough for your check.

## Report

Numbers, not adjectives: the decision you asked about and what was answered, every file
swept, every call site changed, the gate results, and everything you could not verify. No
commits, no pushes, no beads.
