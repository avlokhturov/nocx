// Read-only shell syntax highlighting (ADR-0010 §Decision 4: the language
// layer arrives as a constructor-passed extension, not as editor hard-coding).
//
// Two surfaces consume the SAME tokenizer, so their token classes agree by
// construction:
//   - the live command editor installs `shellExtensions` (CM6 decorations);
//   - frozen block headers run the static `highlightShellText` pass.
// Both are recoloured by a theme switch because the tok-* classes resolve to
// `--color-*` semantic tokens in style.css (ADR-0013: colour literals live in
// themes/ only).
//
// The tokenizer is the VS Code `shellscript` TextMate grammar run through
// Shiki's pure-JS regex engine (`shiki/engine/javascript`) — no Oniguruma
// WASM, so the packaged app's CSP is never involved. `includeExplanation:
// 'scopeName'` yields the grammar's scope names, not theme colours: the
// palette stays with the `--color-*` tokens. The grammar loads asynchronously
// at module init; until it is ready both surfaces render plain text, and the
// live editor re-decorates as soon as the load completes (first paint is
// never blocked; the prompt never waits).
//
// Scope is deliberately syntactic: the tokenizer never asks whether a command
// is on PATH, whether it is an alias or a function, whether a flag is real,
// or whether a path exists. Those need the session's own shell and are out of
// scope (the brief names them explicitly). `sdf` is a command like any other
// word in command position — no existence claim, no diagnostic.

import { createHighlighterCore } from 'shiki/core'
import type { HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { StateEffect } from '@codemirror/state'
import type { Extension, Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'

// ── Grammar loading ─────────────────────────────────────────────────────────

/** The loaded highlighter, or null until the async init below completes. */
let highlighter: HighlighterCore | null = null

/** Callbacks that want to run once the tokenizer exists (frozen-header repaint). */
const readyCallbacks = new Set<() => void>()

/**
 * Resolves when the tokenizer is ready to colour text. Tests await this
 * before asserting classes; the app never blocks on it (plain text until
 * ready). The grammar module is ~45 KB and the engine is pure JS, so this
 * completes in a few milliseconds at startup.
 */
export const shellHighlightReady: Promise<void> = (async () => {
  const hl = await createHighlighterCore({
    langs: [import('@shikijs/langs/shellscript')],
    themes: [import('@shikijs/themes/nord')],
    engine: createJavaScriptRegexEngine(),
  })
  highlighter = hl
  for (const cb of readyCallbacks) cb()
  readyCallbacks.clear()
})()

/**
 * Run `cb` once the tokenizer is ready (on a microtask if it already is).
 * Used by the frozen-header path to repaint headers that were rendered while
 * the grammar was still loading.
 */
export function onShellHighlightReady(cb: () => void): void {
  if (highlighter !== null) {
    queueMicrotask(cb)
    return
  }
  readyCallbacks.add(cb)
}

// ── Scope-name → tok-* class mapping ────────────────────────────────────────
//
// Matched by longest prefix first, so `string.unquoted.argument` beats
// `string.` and `keyword.operator` beats `keyword.`. The grammar's full scope
// vocabulary is not enumerated here — only the roles the existing `.tok-*`
// classes in style.css express.

const SCOPE_CLASSES: ReadonlyArray<readonly [prefix: string, cls: string]> = [
  ['punctuation.definition.string.heredoc', 'tok-heredoc'],
  ['punctuation.terminator.statement', 'tok-operator'],
  ['punctuation.separator.statement', 'tok-operator'],
  ['punctuation.definition.string', 'tok-string'],
  ['string.unquoted.heredoc', 'tok-heredoc'],
  ['support.function.builtin', 'tok-command'],
  ['string.unquoted.argument', 'tok-path'],
  ['constant.other.option', 'tok-flag'],
  ['entity.name.function', 'tok-command'],
  ['entity.name.command', 'tok-command'],
  ['keyword.operator', 'tok-operator'],
  ['variable.', 'tok-variable'],
  ['constant.', 'tok-atom'],
  ['keyword.', 'tok-keyword'],
  ['comment.', 'tok-comment'],
  ['string.', 'tok-string'],
]

// ── Shared tokenizer ────────────────────────────────────────────────────────

interface ShellToken {
  from: number
  to: number
  cls: string
}

/**
 * The one tokenizer. Synchronous once the grammar is loaded (measured ~0.23 ms
 * per realistic command line); returns [] while the grammar is still loading.
 *
 * A token's explanation carries the grammar's scope stack for that token,
 * outermost first, possibly across several nested rules. The innermost scope
 * is the most specific role, so scopes are walked inside-out; the first scope
 * that names a role we style wins. Adjacent tokens that map to the same class
 * (e.g. `"` + content + `"` of a quoted string) are merged into one span so
 * the live line and the frozen header render identically.
 */
function tokenizeShell(text: string): ShellToken[] {
  const hl = highlighter
  if (!hl || text.length === 0) return []
  const { tokens } = hl.codeToTokens(text, {
    lang: 'shellscript',
    theme: 'nord',
    includeExplanation: 'scopeName',
  })
  const out: ShellToken[] = []
  for (const lineTokens of tokens) {
    for (const t of lineTokens) {
      if (t.content.length === 0 || /^\s+$/.test(t.content)) continue
      let cls: string | null = null
      const explanation = t.explanation ?? []
      for (let k = explanation.length - 1; k >= 0 && cls === null; k--) {
        const scopes = explanation[k].scopes
        for (let j = scopes.length - 1; j >= 0 && cls === null; j--) {
          const scopeName = scopes[j].scopeName
          for (const [prefix, candidate] of SCOPE_CLASSES) {
            if (scopeName.startsWith(prefix)) {
              cls = candidate
              break
            }
          }
        }
      }
      if (cls === null) continue
      // Shiki 4.x reports offsets absolute in the document, not per line.
      const from = t.offset
      const to = from + t.content.length
      const prev = out[out.length - 1]
      if (prev && prev.to === from && prev.cls === cls) {
        prev.to = to
      } else {
        out.push({ from, to, cls })
      }
    }
  }
  return out
}

// ── Live editor: CM6 decorations from the tokens ────────────────────────────

/** Forces every live surface to re-tokenize (fired once the grammar loads). */
const refreshEffect = StateEffect.define<null>()

/** One mark decoration per tok-* class, shared across ranges and views. */
const MARKS: Record<string, Decoration> = Object.fromEntries(
  [...new Set(SCOPE_CLASSES.map(([, cls]) => cls))].map((cls) => [
    cls,
    Decoration.mark({ class: cls }),
  ]),
)

function computeDecorations(text: string): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  for (const { from, to, cls } of tokenizeShell(text)) {
    ranges.push(MARKS[cls].range(from, to))
  }
  return Decoration.set(ranges, true)
}

class ShellHighlight {
  decorations: DecorationSet
  /** False once the owning view is destroyed; gates the async re-decoration. */
  private alive = true

  constructor(view: EditorView) {
    this.decorations = computeDecorations(view.state.doc.toString())
    if (highlighter === null) {
      void shellHighlightReady.then(() => {
        if (this.alive) view.dispatch({ effects: refreshEffect.of(null) })
      })
    }
  }

  destroy() {
    this.alive = false
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect)))
    ) {
      this.decorations = computeDecorations(update.state.doc.toString())
    } else {
      this.decorations = this.decorations.map(update.changes)
    }
  }
}

const shellHighlightPlugin = ViewPlugin.fromClass(ShellHighlight, {
  decorations: (v) => v.decorations,
})

/** Install in a CommandEditor to colour the live command line. */
export const shellExtensions: Extension[] = [shellHighlightPlugin]

// ── Frozen headers: the same tokens as HTML ─────────────────────────────────

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/** Escape text for an HTML text node (enough for our own span building). */
function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => ESCAPE[ch])
}

/**
 * Static pass for frozen block headers: tokenize `text` with the same
 * tokenizer the live editor uses, and return HTML where every token range is
 * wrapped in its class. The text itself is always escaped, so the result is
 * safe to assign to innerHTML. While the grammar is still loading this is the
 * plain escaped text — identical to what the live editor shows pre-ready.
 */
export function highlightShellText(text: string): string {
  const tokens = tokenizeShell(text)
  if (tokens.length === 0) return escapeHtml(text)
  let html = ''
  let pos = 0
  for (const { from, to, cls } of tokens) {
    html += escapeHtml(text.slice(pos, from))
    html += `<span class="${cls}">${escapeHtml(text.slice(from, to))}</span>`
    pos = to
  }
  html += escapeHtml(text.slice(pos))
  return html
}
