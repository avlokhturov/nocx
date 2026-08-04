# nocx-atyf — integration just happens, and the UI speaks only when it must

**Epic:** `nocx-atyf`. Five children, and each one's `bd show` carries acceptance criteria
written as assertions — read all six before you start. This brief adds the order, the
boundaries and the traps. Finish the whole epic; the owner wants to test it end to end.

Order: **`.1` first** (it is the model the rest read), then `.2` and `.3` (which depend on
it), and `.4`/`.5` in parallel with those — they touch different files.

## Why this exists

The capability rail shipped in `nocx-4t37.2` and the owner rejected it on sight, with five
complaints that are all correct: it permanently eats a row of terminal output for a status
label; the editor **already** has a chip row saying where you are (`nocx-editor-location`,
`nocx-editor-cwd` in `frontend/src/editor.ts`), so the capability chip is a second
vocabulary for one question in a second place; its `FloatingPanel` popover renders as a
full-width banner that pushes the pane down; on a tab with no editor it floats bottom-left
over the terminal; and clicking "Integrate this shell" produced the toast *"only available
from a trusted prompt"* — an offered action the gate refused.

Codex reviewed it on 2026-08-04. Its diagnosis and its two findings are recorded in the
epic and in `.1`, `.3` and `.4`. Read them; they are the design.

## The invariant — write it as a test, not a comment

> **Every visible action is executable from the state in which it is shown. If prerequisites
> are absent, the action is OMITTED. Clicking an offered action never produces a
> prerequisite-rejection message.**

This one requirement kills the worst defect in what was rejected. `.1` makes it derivable
(the action set is computed only after **authorisation** and **technical eligibility** are
both resolved) and `.2` makes it observable.

## The boundaries — what they already decided

- **ADR-0004 §1 and its scope note** — the input-ownership machine governs **keyboard
  ownership**, stays marker-only and fail-open. **Do not touch `input-state.ts`.** The note
  also states that the authorisation for in-band delivery is the explicit user gesture,
  which is why `.3` asks once rather than injecting silently — and `.3` extends that note
  rather than quietly redefining it.
- **AD-6** — the backend never sniffs the byte stream. `.4`'s "app-owned start" is the
  renderer knowing what **it** submitted (ADR-0004 §2 hands the line over atomically), not
  reading anything.
- **ADR-0006** — marker-only prompt; why a nested environment is only partly visible.
- **`frontend/src/ui/README.md`** — read it before touching a component. A surface may
  **place** a kit component and may never **repaint** it. `ui/capability-chip.ts` exists
  and has a README row; if its shape is wrong now, change the kit deliberately (variants,
  not near-duplicates) and update the row — do not fork a chip into the editor.
- **`nocx-695k.1`已 landed**: the marker-arrived fact is environment-scoped
  (`frontend/src/environment-commands.ts` + `terminal-content.ts`). `.3` builds on it.

## Traps, named

1. **Do not keep the rail "just for the exception case."** `nocx-capability-rail`, its
   `FloatingPanel` variant `capability`, `_mountRail`, `_renderRail`, `_railActions`,
   `_railTitle` and the popover plumbing all go. The exception affordance lives in the
   editor's existing chrome row (`chromeLeft` in `editor.ts`, beside the location and cwd
   chips), and **the chip is the action** — one click, no popover, no caret into a menu.
2. **On a tab with no editor chrome there is NO floating chip.** That was complaint 4. The
   action goes in the tab/terminal context menu and the palette instead (`.5` builds both;
   `.2` uses them).
3. **The words `Native input`, `Enhanced input` and `Command blocks` disappear from the
   UI.** They are our internal taxonomy. Label the recovery **action**: "Enable command
   editor", "Retry integration", "Restore command editor". The model may keep whatever
   names it likes — this is about what a user reads.
4. **The healthy state shows nothing.** Assert the absence in a test; that is the whole
   point and it is the easiest thing to lose later.
5. **`.4` fabricates no OSC 133 C** and reads no bytes. Start comes from our own submit,
   end from `D`. The internal model must still record that C was never received.
6. **`.3` never offers or attempts on a remote command, a redirection, a pipeline,
   non-interactive ssh, or an alt-screen state.** We can parse the line because we sent it.
   Anything we cannot classify confidently: no offer.

## Acceptance — the epic's

Read `bd show nocx-atyf` for the full text. In short: connect from a saved profile and get
command blocks with **nothing on screen announcing it**; type `ssh host` into the editor and
be asked **once**, with that destination silent forever after; see a running command look
like it is running on busybox; find the way to a plain terminal and back without knowing our
vocabulary; and never be offered an action that cannot be taken.

**One end-to-end check watches the whole arc** against a real bash on a real PTY —
`cmd/e2e-sshd` exists and `e2e/shell-mode.spec.ts` already uses it, so there is no excuse
about the harness. Note that `e2e/shell-mode.spec.ts` asserts the rail you are deleting;
rewrite it to the new behaviour rather than deleting the coverage.

## Out of scope

- The Tier B relay itself (`nocx-if6` phase B). Only the **shape** of its consent card is
  decided here, and only if `.3` makes it natural — the card names what is installed, where,
  and how it is removed, and its secondary option reads "Continue with command editor only"
  (Tier A stays on), with "not now" remembered per host and a separate global never-offer.
- `nocx-695k.2`/`.3` (tab title, ports panel target) — a different epic.
- `nocx-wzc4.12` (forwards invisible without a tab).

## Working rules

TDD, failing test first. Full local gate before you report: `gofumpt -l .`,
`golangci-lint run`, `go test -race ./...` (dash/zsh are not on this box's PATH — use
`nix shell nixpkgs#dash nixpkgs#zsh --command go test ...`), and in `frontend/`:
`npx prettier --check .`, `npx eslint .`, `npm run typecheck`, `npm test`. Commit per child
with its bead id. Report a blocker via `orca orchestration ask` the same minute you hit it.
Do not report as done anything with no caller from `main()` — reachable-from-tests is not
reachable, and it has already cost this epic two round trips.
