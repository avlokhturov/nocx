// The ask entry gesture (nocx-4wtlh): the caret indicator that renders
// InputTargetRegistry.active(), and the reference chips a selection raises.
//
// The rule the whole gesture stands on: NOTHING but the person changes where
// Enter goes. The indicator is the ADR-0004 §3 "UI chip" — the active
// target, rendered in the input line immediately left of the cursor. It is
// operable (click, and the ⇧⌘Enter chord) because the ADR requires an
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

// ── The caret indicator (ADR-0004 §3's UI chip) ────────────────────────────

/** Repaint signal: the registry's active target changed (or the host wants
 *  the chip re-read). */
const refreshIndicator = StateEffect.define<null>()

class TargetIndicatorWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly onToggle: () => void,
  ) {
    super()
  }
  /** The plugin hands the widget the indicator's stable toggle — never
   *  per-render closures (eq() skips re-renders on label equality). */
  readonly toggle = (): void => this.onToggle()
  eq(other: TargetIndicatorWidget): boolean {
    return other.label === this.label
  }
  toDOM(): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'nocx-chip nocx-editor-target-indicator'
    btn.dataset.target = this.label.toLowerCase()
    btn.setAttribute('aria-label', `Enter goes to ${this.label}. Click to switch.`)
    btn.textContent = this.label
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

function indicatorDecorations(view: EditorView, box: TargetIndicator): DecorationSet {
  const sel = view.state.selection.main
  // A real selection in the draft hides the chip: it is a CARET indicator,
  // and inside a selection there is no single caret to sit beside.
  if (!sel.empty) return Decoration.none
  return Decoration.set([
    Decoration.widget({
      widget: new TargetIndicatorWidget(box.label, box.toggle),
      // Immediately LEFT of the cursor: side -1 renders the widget before
      // the caret at its own position (the ghost text uses the default
      // side, after the caret — the two never collide).
      side: -1,
    }).range(sel.head, sel.head),
  ])
}

/**
 * The caret indicator: renders the active input target's label in the input
 * line, immediately left of the cursor, and toggles the target on click.
 * The host owns the label's truth — it wires the registry's active target
 * and pushes every change through set(). The editor stays passive; this is
 * a decoration, never a second input owner.
 */
export class TargetIndicator {
  label = 'Shell'
  /** The explicit switch (ADR-0004 §3): wired once by the host; the
   *  widgets and the ⇧⌘Enter seam both end here. Reads the registry live
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

  /** Repaint with the active target's label — called by the host whenever
   *  the registry reports a change, never on any other signal. */
  set(label: string): void {
    if (this.label === label && this.view) return
    this.label = label
    this.view?.dispatch({ effects: refreshIndicator.of(null) })
  }
}

/** The plugin half of the indicator: a widget at the caret that follows
 *  the selection, repainted on doc/selection changes and on the refresh
 *  effect set() dispatches. */
function indicatorPlugin(indicator: TargetIndicator): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        indicator.attachView(view)
        this.decorations = indicatorDecorations(view, indicator)
      }
      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.transactions.some((t) => t.effects.some((e) => e.is(refreshIndicator)))
        ) {
          this.decorations = indicatorDecorations(update.view, indicator)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )
}
