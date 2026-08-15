// The ask entry gesture (nocx-4wtlh): the caret indicator that renders
// InputTargetRegistry.active(), and the reference chips a selection raises.
//
// The rule the whole gesture stands on: NOTHING but the person changes where
// Enter goes. The indicator is the ADR-0004 §3 "UI chip" — the active
// target, rendered in the input line immediately left of the cursor. It is
// operable (click, and the ⌘/Ctrl+Enter chord) because the ADR requires an
// explicit switch, but in ordinary use nobody operates it: it is the
// confirmation that Enter goes to the shell.
//
// Selecting a region of a finished block's output FREEZES that region into a
// reference chip in the input line: "if you ask, this comes with you". It
// never arms ask — the active target does not move (the owner's Warp
// complaint: a selection that armed ask would send the next typed command
// to the model).

import { StateEffect, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

// ── Reference chips ────────────────────────────────────────────────────────

export interface ReferenceChip {
  /** Stable identity for dismissal and exact-duplicate dedupe. */
  readonly id: string
  /** The finished block the selection landed in — the frame source and the
   *  chip's scope. Never re-derived from DOM selection at submit time
   *  (AD-8: selection is copy; the chip is the mode's record). */
  readonly blockEl: HTMLElement
  /** The chip's name: the block's command and the covered row range. */
  readonly label: string
  /** First covered term-line index, inclusive, 0-based. */
  readonly rowStart: number
  /** One past the last covered term-line index, exclusive. */
  readonly rowEnd: number
}

/** The block output whose term-line indices a chip's rows refer to. A chip
 *  may only point into ONE finished block's output: a running block's rows
 *  move, and a selection crossing two blocks has no single frame. */
function chipSourceOf(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null)
  const output = el?.closest<HTMLElement>('.cmd-output')
  if (!output) return null
  const block = output.closest<HTMLElement>('.cmd-block')
  if (!block || block.classList.contains('cmd-block-running')) return null
  return output
}

/** Map a live DOM selection to a frozen-region chip, or null when the
 *  selection cannot be one: collapsed, spanning two blocks, or anchored
 *  outside a finished block's output. Both ends must land inside the SAME
 *  output's term-lines; the covered rows are the inclusive span between
 *  them. */
export function chipFromSelection(
  sel: Selection | null,
): Omit<ReferenceChip, 'id' | 'label'> | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  const startOutput = chipSourceOf(range.startContainer)
  const endOutput = chipSourceOf(range.endContainer)
  if (!startOutput || startOutput !== endOutput) return null
  const lines = Array.from(startOutput.querySelectorAll<HTMLElement>('.term-line'))
  if (lines.length === 0) return null
  const startLine =
    range.startContainer instanceof Element
      ? range.startContainer.closest<HTMLElement>('.term-line')
      : range.startContainer.parentElement?.closest<HTMLElement>('.term-line')
  const endLine =
    range.endContainer instanceof Element
      ? range.endContainer.closest<HTMLElement>('.term-line')
      : range.endContainer.parentElement?.closest<HTMLElement>('.term-line')
  if (!startLine || !endLine) return null
  const rowStart = lines.indexOf(startLine)
  const rowEnd = lines.indexOf(endLine)
  if (rowStart === -1 || rowEnd === -1) return null
  const first = Math.min(rowStart, rowEnd)
  const last = Math.max(rowStart, rowEnd)
  return {
    blockEl: startOutput.closest<HTMLElement>('.cmd-block')!,
    rowStart: first,
    rowEnd: last + 1,
  }
}

/** The exact-duplicate fingerprint: same block, same rows. Reselecting the
 *  identical region must not stack a second chip. */
export function chipFingerprint(
  chip: Pick<ReferenceChip, 'blockEl' | 'rowStart' | 'rowEnd'>,
): string {
  return `${chip.blockEl.dataset.blockId ?? 'block'}:${chip.rowStart}:${chip.rowEnd}`
}

// ── The line-start indicator (ADR-0004 §3's UI chip) ───────────────────────

/** Repaint signal: the registry's active target changed (or the host wants
 *  the chip re-read). */
const refreshIndicator = StateEffect.define<null>()

/** The indicator's OWN word for a target — what the person does, never the
 *  target's internal name. InputTarget.label stays the registry's word
 *  ('Shell'/'Agent' — other consumers may legitimately read it); this map
 *  is the indicator's vocabulary, keyed by target id. Unknown ids fall
 *  back to the label (a future target still gets an honest chip). */
const TARGET_WORD: Record<string, string> = {
  shell: 'Run',
  agent: 'Ask',
}

function targetWord(targetId: string, label: string): string {
  return TARGET_WORD[targetId] ?? label
}

class TargetIndicatorWidget extends WidgetType {
  constructor(
    private readonly word: string,
    private readonly targetId: string,
    private readonly onToggle: () => void,
  ) {
    super()
  }
  /** The plugin hands the widget the indicator's stable toggle — never
   *  per-render closures (eq() skips re-renders on word equality). */
  readonly toggle = (): void => this.onToggle()
  eq(other: TargetIndicatorWidget): boolean {
    return other.word === this.word
  }
  toDOM(): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'nocx-chip nocx-editor-target-indicator'
    btn.dataset.target = this.targetId
    btn.setAttribute('aria-label', `Enter goes to ${this.word}. Click to switch.`)
    btn.textContent = this.word
    btn.addEventListener('click', (e) => {
      // The chip is a control, not a caret placement: never let the click
      // also move the caret into the text at its position.
      e.preventDefault()
      e.stopPropagation()
      this.onToggle()
    })
    return btn
  }
}

function indicatorDecorations(box: TargetIndicator): DecorationSet {
  return Decoration.set([
    Decoration.widget({
      widget: new TargetIndicatorWidget(box.word, box.targetId, box.toggle),
      // LEFT OF THE LINE, never left of the caret (nocx-4wtlh, owner's
      // correction after living with it): position 0 with side -1 is a
      // stable prefix token, the way a prompt sigil sits. A token that
      // followed sel.head travelled through the text on every keystroke,
      // pushed the line around, and had to be re-found after each one —
      // the flicker this design exists to avoid. It stays put.
      side: -1,
    }).range(0, 0),
  ])
}

/**
 * The line-start indicator: a stable prefix token in the input line
 * rendering what the ACTIVE target does — `Run` for the shell, `Ask` for
 * the assistant — and toggling the target on click. The host wires the
 * registry's active target and pushes every change through set(); the word
 * is this module's own mapping (targetWord), never a rename of the target.
 * The editor stays passive; this is a decoration, never a second input
 * owner.
 */
export class TargetIndicator {
  /** The word currently rendered, for the plugin's decorations. */
  word = targetWord('shell', 'Shell')
  /** The target id currently rendered (the data-target hook). */
  targetId = 'shell'
  /** The explicit switch (ADR-0004 §3): wired once by the host; the
   *  widgets and the ⌘/Ctrl+Enter seam both end here. Reads the registry live
   *  at call time, so it never goes stale. */
  readonly toggle: () => void
  private view: EditorView | null = null

  constructor(toggle: () => void) {
    this.toggle = toggle
  }

  /** The CM6 extension the host feeds to the CommandEditor. The plugin
   *  reads the indicator through the module's factory — a function
   *  parameter, never an aliased `this`. */
  extension(): Extension {
    return indicatorPlugin(this)
  }

  /** The plugin registers the live view so set() can repaint it. */
  attachView(view: EditorView): void {
    this.view = view
  }

  /** Repaint with the registry's active target — called by the host
   *  whenever the registry reports a change, never on any other signal.
   *  The WORD is derived here (targetWord); the indicator never shows the
   *  target's internal label. */
  set(targetId: string, label: string): void {
    const word = targetWord(targetId, label)
    if (this.word === word && this.targetId === targetId && this.view) return
    this.word = word
    this.targetId = targetId
    this.view?.dispatch({ effects: refreshIndicator.of(null) })
  }
}

/** The plugin half of the indicator: a widget at the START of the line
 *  (position 0), repainted on doc/selection changes and on the refresh
 *  effect set() dispatches. The widget never moves with the caret or the
 *  text — it is a sigil, not a follower. It also stays visible during a
 *  selection: a person selecting part of their command still wants to
 *  know where Enter goes, and a line-start token has no reason to hide
 *  (the old caret-anchored chip hid because it sat inside the selection). */
function indicatorPlugin(indicator: TargetIndicator): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(private readonly view: EditorView) {
        indicator.attachView(view)
        this.decorations = indicatorDecorations(indicator)
        this.publishWidth()
      }
      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.transactions.some((t) => t.effects.some((e) => e.is(refreshIndicator)))
        ) {
          this.decorations = indicatorDecorations(indicator)
          this.publishWidth()
        }
      }
      /** Publish the token's RENDERED width for the hanging indent every
       *  other line hangs on (style.css, `.cm-line`). It is measured, not
       *  assumed: the word changes with the target (`Run` / `Ask`) in a
       *  proportional font, so a constant would misalign the continuation
       *  lines the moment somebody switched. Through requestMeasure, so
       *  the read never lands mid-write. */
      private publishWidth(): void {
        this.view.requestMeasure({
          read: (view) => {
            const btn = view.contentDOM.querySelector<HTMLElement>('.nocx-editor-target-indicator')
            if (!btn) return 0
            // The trailing gap belongs to the token as much as the chip
            // does: the caret sits after the buffer, so the text on every
            // other line must line up with the caret, not with the chip's
            // border.
            const buffer = btn.nextElementSibling as HTMLElement | null
            return btn.offsetWidth + (buffer?.offsetWidth ?? 0)
          },
          write: (width, view) => {
            view.dom.style.setProperty('--nocx-target-token-width', `${width}px`)
          },
        })
      }
    },
    { decorations: (v) => v.decorations },
  )
}
