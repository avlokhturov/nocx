// Read-only shell syntax highlighting (ADR-0010 §Decision 4: the language
// layer arrives as a constructor-passed extension, not as editor hard-coding).
//
// Two surfaces consume the SAME lexer and the SAME highlighter, so their
// token classes agree by construction:
//   - the live command editor installs `shellExtensions`;
//   - frozen block headers run the static `highlightShellText` pass.
// Both are recoloured by a theme switch because the tok-* classes resolve to
// `--color-*` semantic tokens in style.css (ADR-0013: colour literals live in
// themes/ only).
//
// Scope is deliberately syntactic: the lexer never asks whether a command is
// on PATH, whether it is an alias or a function, whether a flag is real, or
// whether a path exists. Those need the session's own shell and are out of
// scope (the brief names them explicitly).

import {
  HighlightStyle,
  StreamLanguage,
  StringStream,
  syntaxHighlighting,
} from '@codemirror/language'
import type { StreamParser } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { Tag, highlightTree, tags } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

/** Fresh tag for the redirect-target role, which the legacy mode cannot express. */
const pathTag = Tag.define()

/** Characters the legacy shell mode leaves unstyled: pipes, redirects, separators. */
const OPERATORS: Record<string, true> = { '|': true, '>': true, ';': true, '&': true }

/** The shell mode's own token stack, plus our redirect flag. */
interface ShellState {
  tokens: unknown[]
  redirect: boolean
}

/**
 * The legacy shell mode styles words, flags, strings, comments, variables,
 * heredocs and numbers, but nothing else: `|`, `>`, `;`, `&` and redirect
 * targets fall through unstyled. This wrapper fills exactly those two gaps
 * and delegates everything else to the mode, so nothing the mode already
 * colours (including quoted strings containing operators) changes.
 */
const shellStream: StreamParser<ShellState> = {
  name: 'shell',
  startState(): ShellState {
    return { tokens: [], redirect: false }
  },
  token(stream: StringStream, state: ShellState): string | null {
    if (stream.eatSpace()) return null

    // The token right after a `>`/`>>`/`>&` redirection is its target.
    if (state.redirect) {
      state.redirect = false
      const ch = stream.peek()
      if (ch !== undefined && OPERATORS[ch] !== true && ch !== '"' && ch !== "'" && ch !== '`') {
        stream.eatWhile(/[^\s|;&<>()'"]/)
        return 'path'
      }
      // `>&1`-style fd targets fall through to the operator handling below.
    }

    const ch = stream.peek()
    if (ch !== undefined && OPERATORS[ch] === true) {
      stream.next()
      // Consume the second character of `||`, `&&`, `>>`, `|&`, `>&`, `>|`.
      const next = stream.peek()
      if (
        next !== undefined &&
        (next === ch ||
          (ch === '|' && next === '&') ||
          (ch === '>' && (next === '&' || next === '|')) ||
          (ch === '&' && next === '>'))
      ) {
        stream.next()
      }
      if (ch === '>') state.redirect = true
      return 'operator'
    }

    return shell.token(stream, state)
  },
  // Maps our custom style name to a real tag; every other name the mode
  // emits resolves through the standard legacy-name table (e.g. 'builtin' →
  // variableName.standard, 'attribute' → attributeName).
  tokenTable: { path: pathTag },
  languageData: shell.languageData,
}

/** The shell language: one lexer for the live editor and the frozen pass. */
export const shellLanguage = StreamLanguage.define<ShellState>(shellStream)

/**
 * Token colours as classes, resolved to `--color-*` tokens in style.css.
 * The class set is the parity contract between the live line and the frozen
 * headers — both surfaces produce exactly these classes or none.
 */
export const shellHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, class: 'tok-comment' },
  { tag: tags.meta, class: 'tok-meta' },
  { tag: tags.keyword, class: 'tok-keyword' },
  { tag: tags.standard(tags.variableName), class: 'tok-command' },
  { tag: tags.attributeName, class: 'tok-flag' },
  { tag: tags.operator, class: 'tok-operator' },
  { tag: tags.string, class: 'tok-string' },
  { tag: tags.special(tags.string), class: 'tok-heredoc' },
  { tag: tags.definition(tags.variableName), class: 'tok-variable' },
  { tag: tags.atom, class: 'tok-atom' },
  { tag: pathTag, class: 'tok-path' },
])

/** Install in a CommandEditor to colour the live command line. */
export const shellExtensions: Extension[] = [
  shellLanguage.extension,
  syntaxHighlighting(shellHighlightStyle),
]

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/** Escape text for an HTML text node (enough for our own span building). */
function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => ESCAPE[ch])
}

/**
 * Static pass for frozen block headers: tokenize `text` with the same lexer
 * and highlighter the live editor uses, and return HTML where every token
 * range is wrapped in its class. The text itself is always escaped, so the
 * result is safe to assign to innerHTML.
 */
export function highlightShellText(text: string): string {
  const ranges: Array<[number, number, string]> = []
  highlightTree(shellLanguage.parser.parse(text), shellHighlightStyle, (from, to, classes) => {
    if (from < to) ranges.push([from, to, classes])
  })
  let html = ''
  let pos = 0
  for (const [from, to, classes] of ranges) {
    html += escapeHtml(text.slice(pos, from))
    html += `<span class="${classes}">${escapeHtml(text.slice(from, to))}</span>`
    pos = to
  }
  html += escapeHtml(text.slice(pos))
  return html
}
