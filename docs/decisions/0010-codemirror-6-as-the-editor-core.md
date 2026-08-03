# ADR-0010 — CodeMirror 6 as the editor core

- **Status:** Accepted
- **Date:** 2026-08-01
- **Related:** [ADR-0004](0004-input-ownership-and-editor-abstraction.md) §3 (the editor is
  a passive surface behind a pluggable `InputTarget`; start with a `<textarea>`; "CodeMirror
  is introduced only when syntax-aware editing or inline widgets justify it"; "Avoid
  `contenteditable`"), [ADR-0006](0006-marker-only-prompt-mode.md) §5 (fail-open),
  [ADR-0005](0005-linux-webkitgtk-forced-refresh-pump.md) (this webview has opinions about
  when it repaints).
- **Design:** `.internal/specs/2026-07-25-editor-core-codemirror6-design.md` (the binding
  spec: W1–W5, W7), `.internal/specs/2026-07-31-command-blocks-history-syntax-design.md`
  §8 (the first real consumer).
- **Epic:** `nocx-2gf`. This ADR is W7 and precedes W1.
- **Narrows:** ADR-0004 §3's `contenteditable` prohibition, from all uses to the
  hand-rolled use.

## Context

ADR-0004 §3 chose a native `<textarea>` and named the condition under which that choice
expires: _"CodeMirror is introduced only when syntax-aware editing or inline widgets
justify it."_ **That condition has now been met three times over**, so this ADR is §3
firing as designed rather than §3 being overturned.

Three committed features need the same two things a `<textarea>` cannot provide — a render
layer independent of the input surface, and character-level screen coordinates:

- **Shell token highlighting** (`nocx-dgs`). A textarea renders one uniform colour. There is
  no supported way to colour a range inside it.
- **Ghost text and the completion dropdown** (`nocx-4ff.23`, design §8.7). Inline
  decorations and a popup anchored to the caret both need coordinates the textarea does not
  expose.
- **The recall overlay** (design §8.10, `nocx-w7h`). Preview, draft restoration and
  multiline caret arbitration against a surface that has none of those concepts.

Building all three on a textarea means hand-rolling caret measurement and a popup — a
mirrored-layer approach — and then discarding it. The measured bundle cost is not the
obstacle: CM6 (`state` + `view` + `autocomplete` + `commands` + legacy shell mode) is
321 KB raw / 102 KB gzip against xterm.js's 289 KB / 65 KB, which is immaterial for a
desktop application.

The blast radius is also at its lifetime minimum. `CommandEditor` has one consumer
(`tabs.ts`, 13 call sites), and every later feature adds more.

## Decision

### 1. The editor core is CodeMirror 6

`CommandEditor`'s internals become a CM6 `EditorView` mounted inside the existing
`.nocx-editor` card. The editor chrome — cwd chip, time chip — stays as plain DOM siblings.

**The public API is the contract, and the swap is behaviour-preserving.** `root`, `mount`,
`setCwd`, `setTime`, `show`, `hide`, `focus`, `isVisible`, `rootContains`, `dispose` and
`insertText` keep their signatures and semantics; the `textarea` getter is removed and
replaced by `onSelectionEnd(cb)`. No user-facing feature lands in this epic. Features come
afterwards, in the semantic epic.

### 2. The `contenteditable` ban is narrowed, not lifted

ADR-0004 §3 ends "Avoid `contenteditable`", and CM6 uses one internally. The ban targeted
the **hand-rolled** variant, and the reasons behind it — broken IME composition, lost native
undo, selection and caret handling that has to be rebuilt badly — are precisely what CM6
exists to solve and has solved for years.

> **A hand-rolled `contenteditable` input surface remains prohibited.** A maintained editor
> engine that owns IME, undo and selection is the mitigation for the risk that prohibition
> was written against, not an exception to it.

Anyone reading §3's sentence in isolation must not be able to follow it into building an
overlay by hand; §3 is annotated to point here.

### 3. The extension list is a constructor parameter, and nothing more is promised

`CommandEditor` must not hard-code its language or decoration set. The extension list is
passed in at construction. That is the whole of what this epic owes the later per-target
work.

**`editorExtensions?()` on `InputTarget` is NOT introduced here.** An earlier draft of the
binding spec claimed `InputTarget` already declared optional `complete?()` and `history?()`
members; `frontend/src/input-target.ts` declares only `id`, `label` and `submit`. The ADR
text had been mistaken for the code. With the premise corrected, adding the member now
would be a speculative feature no registered target populates — and a CM6 `Extension` is
broad enough to install keymaps and transaction filters, so handing one to an arbitrary
target would let it override the keymap invariants of §4. It moves to `nocx-w7h`, the first
real consumer, which can shape it against a real requirement and an allow-list.

### 4. Our keymap binds at `Prec.highest`

CM6's `defaultKeymap` binds Enter and Escape. Without explicit precedence, Enter inserts a
newline instead of submitting and Ctrl-C stops interrupting the shell — a silent regression
in the two most-used keys at a prompt. Enter, Shift-Enter, Escape and Ctrl-C are bound
inside `Prec.highest(keymap.of([...]))`, and that is an acceptance criterion rather than a
convention.

### 5. Auto-grow becomes layout, and one behaviour change is admitted

`_grow()` counts newlines and sets `rows`. CM6 grows with its content, so the policy becomes
CSS: `max-height` at ten lines, `overflow-y: auto` past it. This is a behaviour match with
one admitted exception — **a wrapped long line will now grow the box where previously it did
not.** Native undo also becomes CM6's history rather than the browser's; the observable
difference is granularity.

### 6. The de-risk spike is not reinstated, and the measurement is not skipped

The binding spec removed W0 before this ADR, on the reasoning that a spike's deliverable is
a findings note rather than working software and means doing the integration twice. **The
owner confirmed on 2026-08-01 that no separate spike is wanted.** That is a decision about
_form_, and it does not delete the questions:

W0's six checks are acceptance criteria on W1, verified **first**, before the rest of the
swap is polished — focus interplay with xterm and both `rootContains` call sites; keymap
precedence; IME composition; hit-testing over the editor card; geometry under
`visibility:hidden`; and reproduction on WKWebView rather than only Chromium.

**The risk this accepts, stated plainly:** CM6 has never been run in nocx's prompt line in
our own WebKitGTK webview, and ADR-0005 exists because that webview needed a forced refresh
pump. If one of the six checks demands a different migration shape, that is a finding on the
epic and W1 is re-planned — the same outcome a spike would have produced, with working code
already in hand rather than a note.

## Alternatives considered

- **Keep the `<textarea>` and add a mirrored highlight layer behind it.** Token spans painted
  into a positioned layer under transparent text; the textarea keeps caret, selection, IME
  and keymap. **Genuinely cheaper if highlighting were all we wanted**, and rejected because
  it is not: the layer must match the textarea on font, line-height, letter-spacing, padding,
  wrapping and scroll offset or the text visibly drifts — a real risk on a webview that
  already needed ADR-0005 — and it pays nothing toward ghost text, the dropdown or the recall
  overlay, all three of which are committed. It would be built and then thrown away.
- **A hand-rolled `contenteditable` surface.** Prohibited by ADR-0004 §3 and still
  prohibited; §2 above explains why CM6 is not the same choice.
- **Monaco.** IDE-shaped and heavy; the neighbouring `orca` repo uses it, but that is
  Electron with IDE panes, which nocx is not. `termic` — Tauri + React + xterm, our closest
  analogue — uses CM6.
- **Defer the whole question until highlighting is actually being built.** Rejected because
  the decision then gets made implicitly by whoever starts first, which is how a mirrored
  layer becomes permanent by accident.

## Consequences

- `frontend/package.json` gains pinned CM6 packages.
- `tabs.ts:480-491` stops reaching into `editor.textarea` and registers an
  `onSelectionEnd` callback instead; the "should this be copied" policy stays outside the
  editor and the DOM mechanics move inside it.
- `e2e/command-editor.spec.ts` asserts `elementFromPoint` returns a `TEXTAREA` and must be
  rewritten.
- **jsdom performs no layout**, so every CM6 behaviour that depends on measurement — caret
  coordinates, popup placement, wrapping — is untestable there. This forces the vitest
  browser-mode decision (`nocx-foz`) rather than leaving it open.
- IME has **zero** test coverage today, and the document-level keydown redirect at
  `tabs.ts:432` can destroy composition state. This is a pre-existing hole the epic must
  close rather than inherit.
- What actually stacks the editor above `.xterm-link-layer` is unknown (`nocx-0oc`): the
  `z-index: 20` rule the code comments reference is not in the stylesheet. A CM6 swap
  changes the element tree underneath, so W1 must determine what is holding today before it
  disturbs it.

## Not decided here

- The Tab binding (design §17.1). The proposal that Tab could fall through to shell-native
  completion was withdrawn as unbuildable — the editor owns the text and the shell's line
  buffer does not have it.
- Per-target decoration ownership — deferred to `nocx-w7h` (§3 above).
- The submit path's `ESC[200~` bracketing (`nocx-hi2`). Three sources disagree about what it
  does today; this epic holds only the weaker, testable invariant that **whatever the submit
  path is on the day W1 lands, W1 does not change it.**

## Revisit when

- Any of W1's six inherited checks fails in a way that demands a different migration shape.
- A second editor surface appears (the files-and-diffs viewer in the design's §12) and
  `@codemirror/merge` makes the dependency pay for itself twice.
