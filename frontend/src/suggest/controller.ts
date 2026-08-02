// The completion controller — the state machine, the keyboard arbiter and
// the ghost text (design §8.7, §8.9). The editor stays a passive surface:
// the controller reads the document through a minimal seam, renders through
// the kit CompletionDropdown, and owns every key the dropdown needs through
// the editor's arbiter chain (recall first, completion second, editor
// defaults last — see the arbiter comment in editor.ts).
//
// Lifecycle contract, each half testable in isolation:
//
//   - Tab opens the dropdown. With no candidates it sends nothing — never a
//     raw `\t` (§8.7's withdrawn fall-through: the editor owns the text, so
//     a forwarded tab would complete the shell's empty buffer).
//   - First results render as they arrive; a slow provider is never waited
//     for. The LATENCY_BUDGET gates only the open decision: if nothing has
//     arrived within the budget the dropdown stays closed for that query,
//     even if a provider answers later.
//   - A late arrival may not move the selection — within one query, batches
//     merge and the selection tracks the candidate id (merge.ts).
//   - A keystroke aborts: every user document change starts a fresh query,
//     and a provider may not deliver after abort (batches are dropped by
//     generation, never trusted).
//   - A provider's error never kills the others.
//   - The same candidate from two providers dedups by id.
//
// Ghost text (design §8.7) is the ACTIVE candidate — the dropdown's selected
// row when the dropdown is open, the top-ranked candidate otherwise, which
// is what "top-ranked" means when no dropdown is up. It renders inline at
// the caret as a CM6 decoration and accepts with Right/End, subject to every
// §8.7 precondition: caret at the end of the replacement range, empty
// selection, no IME composition (the editor's capture listener never calls
// the arbiter for composing keys), the key would not otherwise move the
// caret (the caret sits at the end of a line), the suggestion belongs to the
// current document revision, and the candidate is eligible — an entry marked
// sensitive is never ghost text.

import {
  EditorView,
  WidgetType,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { StateEffect, type Extension } from '@codemirror/state'
import type { Candidate } from './candidate'
import { mergeCandidates, preserveSelection } from './merge'
import { rankCandidates } from './rank'
import { tokenAt, positionOf } from './token'
import type { SuggestionProvider, SuggestContext } from './providers'
import type { CompletionDropdown } from '../ui/completion-dropdown'

/** How long the dropdown waits for a first result before giving up on
 *  opening for that query (a slow provider is never waited for). */
export const LATENCY_BUDGET_MS = 250

/** The minimal editor surface the controller drives. CommandEditor
 *  satisfies it; tests substitute a fake. */
export interface CompletionEditor {
  getDoc(): string
  getSelection(): { from: number; to: number }
  /** Replace [from, to) with text (programmatic — fires no input events). */
  applyReplacement(from: number, to: number, text: string): void
}

/** Live session facts, read per query (cwd changes with every OSC 7). */
export interface CompletionEnv {
  readonly isLocal: boolean
  readonly cwd: string
  readonly host: string
}

export interface CompletionControllerOptions {
  providers: SuggestionProvider[]
  dropdown: CompletionDropdown
  env: () => CompletionEnv
  /** True while the recall overlay is open — the dropdown must never stack
   *  under it. The composition root also dismisses on recall-open; this is
   *  the controller's own guard. */
  recallIsOpen?: () => boolean
  latencyBudgetMs?: number
  now?: () => number
}

/** What one query's accumulated, ranked result looks like. */
interface OpenState {
  readonly name: 'open'
  readonly candidates: Candidate[]
  readonly selectedIndex: number
  /** The generation whose results are displayed. */
  readonly generation: number
}

type DropdownState = { readonly name: 'closed' } | OpenState

/** The shared box between the controller and the ghost ViewPlugin. The
 *  plugin renders only while the box's revision still matches the view's
 *  document — a stale async suggestion is discarded, never applied. */
interface GhostBox {
  candidate: Candidate | null
  queryDoc: string
  view: EditorView | null
}

/** Controller → plugin refresh signal, dispatched after an async batch. */
const refreshGhost = StateEffect.define<null>()

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'nocx-editor-ghost'
    span.textContent = this.text
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** The inline ghost decoration: the completion tail at the caret, only when
 *  every §8.7 precondition holds at render time. */
function ghostDecorations(view: EditorView, box: GhostBox): DecorationSet {
  const c = box.candidate
  if (!c || !c.eligibleForGhostText) return Decoration.none
  if (view.state.doc.toString() !== box.queryDoc) return Decoration.none
  const sel = view.state.selection.main
  if (sel.from !== sel.to) return Decoration.none
  const head = sel.head
  if (head !== c.replacement.to) return Decoration.none
  const tail = c.insertText.slice(head - c.replacement.from)
  if (tail === '') return Decoration.none
  return Decoration.set([Decoration.widget({ widget: new GhostWidget(tail), side: 1 }).range(head)])
}

export class CompletionController {
  private state: DropdownState = { name: 'closed' }
  /** The generation of the query in flight — batches from older generations
   *  are dropped (a provider may not deliver after abort). */
  private generation = 0
  /** Per-query accumulation, so late batches merge instead of replacing. */
  private queryCandidates: Candidate[] = []
  /** The document the current query was issued against — the revision every
   *  accept and ghost render is checked against. */
  private queryDoc = ''
  private abort: AbortController | null = null
  private budgetTimer: number | undefined
  private gaveUp = false
  /** Whether the query in flight may open the dropdown (Tab) or is a typing
   *  query that may only re-anchor the ghost. */
  private openIntent = false
  private editor: CompletionEditor | null = null
  private readonly ghostBox: GhostBox = { candidate: null, queryDoc: '', view: null }

  constructor(private readonly options: CompletionControllerOptions) {}

  // ── CM6 extensions ─────────────────────────────────────────────────────
  // The ghost plugin (reads the shared box; the controller refreshes it via
  // the effect) plus a doc-change listener that keeps the surface honest
  // for changes that never ran a query (paste, a recall preview): the ghost
  // vanishes by revision check, and the stale open list is dismissed.
  extensions(): Extension[] {
    const box = this.ghostBox
    return [
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return
        if (this.editor && this.editor.getDoc() !== this.queryDoc) this.dismiss()
      }),
      ViewPlugin.fromClass(
        class GhostPlugin {
          decorations: DecorationSet
          constructor(view: EditorView) {
            box.view = view
            this.decorations = ghostDecorations(view, box)
          }
          update(update: ViewUpdate): void {
            if (
              update.docChanged ||
              update.selectionSet ||
              update.transactions.some((t) => t.effects.some((e) => e.is(refreshGhost)))
            ) {
              this.decorations = ghostDecorations(update.view, box)
            }
          }
        },
        { decorations: (v) => v.decorations },
      ),
      // The ghost span's style: a muted tail, scoped to this editor.
      EditorView.theme({
        '.nocx-editor-ghost': { color: 'var(--color-text-dim)' },
      }),
    ]
  }

  /** Attach the controller to the live editor and mount the dropdown above
   *  it. The editor's actions (onTab, onInputChange) call back in; this
   *  binds the read seam and the surface. */
  attach(editor: CompletionEditor, mountTarget: HTMLElement): void {
    this.editor = editor
    this.options.dropdown.mount(mountTarget)
  }

  /** Tab pressed with the dropdown closed — open it (or stay closed if the
   *  query yields nothing within the budget). */
  open(): void {
    this.runQuery(true)
  }

  /** A user-driven document change — a keystroke aborts the query in flight
   *  and starts a fresh one, for the ghost and (when open) the dropdown.
   *  Typing never OPENS the dropdown; only Tab does. */
  onDocChanged(): void {
    this.runQuery(false)
  }

  /** Mouse hover: move the selection to an absolute row (the dropdown's
   *  onHover). Same surface as the arrow keys — the ghost follows. */
  select(index: number): void {
    const s = this.state
    if (s.name !== 'open' || index < 0 || index >= s.candidates.length) return
    this.state = { ...s, selectedIndex: index }
    this.render()
  }

  /** Mouse pick: accept an absolute row (the dropdown's onPick), under the
   *  same revision rules as Enter. */
  acceptIndex(index: number): void {
    const s = this.state
    if (s.name !== 'open') return
    const c = s.candidates[index]
    if (!c) return
    if (s.generation !== this.generation || !this.revisionHolds(c)) {
      this.dismiss()
      return
    }
    this.apply(c)
  }

  /** The keyboard arbiter (completion's turn, after recall's). Returns true
   *  when the key was consumed. While the dropdown is open, navigation,
   *  accept and dismiss belong to it; everything else falls through to the
   *  editor (typing re-queries through onDocChanged). */
  handleKey(e: KeyboardEvent): boolean {
    if (e.isComposing || e.keyCode === 229) return false
    if (this.options.recallIsOpen?.()) {
      this.dismiss()
      return false
    }
    const s = this.state
    if (s.name === 'closed') {
      // No dropdown: the only key completion owns is Right/End ghost
      // acceptance — the ghost is the typing surface, and it accepts
      // without a dropdown being up (design §8.7).
      if (e.key === 'ArrowRight' || e.key === 'End') {
        if (this.canAcceptGhost()) {
          this.acceptGhost()
          return this.consume(e)
        }
      }
      return false
    }

    if (e.key === 'ArrowDown') {
      this.move(1)
      return this.consume(e)
    }
    if (e.key === 'ArrowUp') {
      this.move(-1)
      return this.consume(e)
    }
    if (e.key === 'Escape') {
      this.dismiss()
      return this.consume(e)
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Accept the selection — but only while it still belongs to the
      // current revision. A stale list (the doc moved on before the next
      // query's results landed) is dismissed and the key falls through, so
      // Enter submits what is actually in the line.
      if (this.acceptSelected()) return this.consume(e)
      this.dismiss()
      return false
    }
    // Tab cycles the selection — the owner's explicit Warp-shaped ask: the
    // first Tab opens the dropdown, each further Tab moves to the next
    // candidate (Shift+Tab goes back), and accept stays Enter (and Right/End
    // for the ghost). Cycling never inserts; the preview is the ghost text.
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.move(e.shiftKey ? -1 : 1)
      return this.consume(e)
    }
    if (e.key === 'ArrowRight' || e.key === 'End') {
      if (this.canAcceptGhost()) {
        this.acceptGhost()
        return this.consume(e)
      }
      // Otherwise the key is a caret movement — fall through to CM6.
      return false
    }
    return false
  }

  /** Close the dropdown and drop the ghost (Esc, or the recall overlay
   *  taking the surface). The draft is untouched. */
  dismiss(): void {
    if (this.state.name === 'open') {
      this.state = { name: 'closed' }
      this.options.dropdown.hide()
    }
    this.clearGhost()
  }

  destroy(): void {
    this.abort?.abort()
    if (this.budgetTimer !== undefined) clearTimeout(this.budgetTimer)
    this.options.dropdown.destroy()
  }

  private runQuery(openIntent: boolean): void {
    const editor = this.editor
    if (!editor) return
    this.abort?.abort()
    const ac = new AbortController()
    this.abort = ac
    const gen = ++this.generation
    this.queryDoc = editor.getDoc()
    this.queryCandidates = []
    this.gaveUp = false
    // Only a Tab (open()) may OPEN the dropdown; a keystroke (onDocChanged)
    // re-anchors the ghost and — if the dropdown is already open — keeps it
    // live, but never opens it.
    this.openIntent = openIntent
    this.clearGhost()

    const doc = this.queryDoc
    const caret = editor.getSelection().from
    const token = tokenAt(doc, caret)
    const position = positionOf(doc, caret)
    const env = this.options.env()
    const ctx: SuggestContext = {
      doc,
      token,
      position,
      isLocal: env.isLocal,
      cwd: env.cwd,
      host: env.host,
    }

    // The budget bounds the OPEN decision only: nothing within the budget →
    // the dropdown stays closed for this query, whatever arrives later.
    const budget = this.options.latencyBudgetMs ?? LATENCY_BUDGET_MS
    if (budget > 0) {
      this.budgetTimer = setTimeout(() => {
        this.budgetTimer = undefined
        if (this.state.name === 'closed') this.gaveUp = true
      }, budget)
    }

    const applicable = this.options.providers.filter((p) => p.applicable(ctx))
    if (applicable.length === 0) {
      this.abort = null
      return
    }
    for (const provider of applicable) {
      Promise.resolve(provider.suggest(ctx, ac.signal))
        .then((batch) => this.onBatch(gen, batch, position))
        .catch(() => {
          // One provider's error does not kill the others; the dropdown
          // shows what the rest answered.
          this.onBatch(gen, [], position)
        })
    }
  }

  private onBatch(gen: number, batch: Candidate[], position: 'command' | 'argument'): void {
    if (gen !== this.generation) return // a provider may not deliver after abort
    if (this.gaveUp && this.state.name === 'closed') return // the budget expired
    const ranked = rankCandidates(batch, {
      query: this.queryDoc,
      now: (this.options.now ?? Date.now)(),
      position,
    })

    // The first batch of a query REPLACES the previous query's list (the
    // query changed — the old ranking is a lie); later batches merge in and
    // never move the selection off the candidate the user is on.
    const merged =
      this.queryCandidates.length === 0 ? ranked : mergeCandidates(this.queryCandidates, ranked)
    // Re-rank the WHOLE accumulated list, not just the incoming batch: the
    // rungs — argument position puts paths above whole-line history, and a
    // path directory above a path file — must hold across async batches.
    // Whichever provider lands first must not win the top of the list by
    // arrival order; the selection tracks the candidate id, so re-ranking
    // never moves the user's row.
    const ordered = rankCandidates(merged, {
      query: this.queryDoc,
      now: (this.options.now ?? Date.now)(),
      position,
    })
    this.queryCandidates = ordered

    if (this.state.name === 'open') {
      const selected = preserveSelection(
        { selectedIndex: this.state.selectedIndex, candidates: this.state.candidates },
        ordered,
      )
      this.state = { name: 'open', candidates: ordered, selectedIndex: selected, generation: gen }
    } else if (this.openIntent && ordered.length > 0) {
      // A Tab query opens the dropdown on its first results; a typing query
      // never opens it (the ghost is the typing surface).
      this.state = { name: 'open', candidates: ordered, selectedIndex: 0, generation: gen }
    } else {
      this.state = { name: 'closed' }
      this.options.dropdown.hide()
    }
    this.render()
  }

  /** Push the current state to the dropdown and the ghost. */
  private render(): void {
    const s = this.state
    if (s.name === 'open') {
      // The kit draws a display subset; insertText and the replacement range
      // never cross into it (ui/ must not depend back on the app).
      this.options.dropdown.show(
        s.candidates.map((c) => ({
          id: c.id,
          displayText: c.displayText,
          matchRanges: c.matchRanges,
          source: c.source,
          kind: c.kind,
        })),
        s.selectedIndex,
      )
    } else {
      this.options.dropdown.hide()
    }
    this.syncGhost()
  }

  private clearGhost(): void {
    this.ghostBox.candidate = null
    this.ghostBox.queryDoc = ''
  }

  /** The ghost is the active candidate: the selected row when the dropdown
   *  is open, the top-ranked candidate otherwise. */
  private syncGhost(): void {
    const s = this.state
    const candidate =
      s.name === 'open' ? s.candidates[s.selectedIndex] : (this.queryCandidates[0] ?? null)
    this.ghostBox.candidate = candidate
    this.ghostBox.queryDoc = this.queryDoc
    const view = this.ghostBox.view
    if (view) view.dispatch({ effects: refreshGhost.of(null) })
  }

  // ── keyboard actions ───────────────────────────────────────────────────

  private move(dir: -1 | 1): void {
    const s = this.state
    if (s.name !== 'open' || s.candidates.length === 0) return
    const len = s.candidates.length
    const next = (s.selectedIndex + dir + len) % len
    this.state = { ...s, selectedIndex: next }
    this.render()
  }

  /** Accept the selected candidate. Returns false when the list is stale
   *  (the document moved on since the query) — the caller dismisses. */
  private acceptSelected(): boolean {
    const s = this.state
    if (s.name !== 'open') return false
    if (s.generation !== this.generation) return false
    const c = s.candidates[s.selectedIndex]
    if (!c) return false
    if (!this.revisionHolds(c)) return false
    this.apply(c)
    return true
  }

  /** Every §8.7 precondition for Right/End acceptance of the ghost. */
  private canAcceptGhost(): boolean {
    const editor = this.editor
    const c = this.ghostBox.candidate
    if (!editor || !c) return false
    if (!c.eligibleForGhostText) return false
    if (this.ghostBox.queryDoc !== this.queryDoc) return false
    if (this.ghostBox.queryDoc !== editor.getDoc()) return false
    const sel = editor.getSelection()
    if (sel.from !== sel.to) return false
    const doc = editor.getDoc()
    if (sel.from !== c.replacement.to) return false
    // The keystroke would not otherwise move the caret: the caret sits at
    // the end of a line (Right and End both do nothing there).
    const at = sel.from
    if (at < doc.length && doc[at] !== '\n') return false
    return true
  }

  private acceptGhost(): void {
    const c = this.ghostBox.candidate
    if (!c) return
    this.apply(c)
  }

  /** Apply the candidate and close the surface. */
  private apply(c: Candidate): void {
    this.editor?.applyReplacement(c.replacement.from, c.replacement.to, c.insertText)
    this.dismiss()
  }

  /** The suggestion still belongs to the current document revision. */
  private revisionHolds(c: Candidate): boolean {
    const editor = this.editor
    if (!editor) return false
    if (this.queryDoc !== editor.getDoc()) return false
    const sel = editor.getSelection()
    return sel.from === c.replacement.to && sel.from === sel.to
  }

  private consume(e: KeyboardEvent): boolean {
    e.preventDefault()
    e.stopPropagation()
    return true
  }
}
