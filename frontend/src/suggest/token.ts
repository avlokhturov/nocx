// Token extraction and position classification — the rules that decide which
// providers are consulted for the word at the caret (design §8.5: a provider
// declares where it applies and is not consulted outside it).
//
// A token is bounded by whitespace and by shell control characters
// (`|`, `;`, `&`, `(`, `)`, quotes), so `ls | gr` completes `gr` as a fresh
// command-position word, not as the tail of `ls|gr`. Slashes, dots and tildes
// stay inside the token — they are what makes it a path.

/** The word being completed and where it sits in the document. */
export interface CompletionToken {
  /** The word at the caret ('' at a boundary or on an empty line). */
  text: string
  /** Document offset of the word start. */
  from: number
  /** Document offset of the word end (the caret, when the caret is at the end). */
  to: number
}

/** Where the token sits in the line — decides command vs path providers. */
export type TokenPosition = 'command' | 'argument'

/** Characters that end a shell word besides whitespace. */
const TOKEN_BOUNDARY = /[\s|&;()<>'"`]/

/**
 * The maximal shell word containing `pos`. Quotes are boundaries: `echo "fo`
 * yields the fragment being typed, because the completed text must not eat a
 * quote the user has not closed.
 */
export function tokenAt(doc: string, pos: number): CompletionToken {
  const clamped = Math.max(0, Math.min(doc.length, pos))
  let from = clamped
  while (from > 0 && !TOKEN_BOUNDARY.test(doc[from - 1])) from--
  let to = clamped
  while (to < doc.length && !TOKEN_BOUNDARY.test(doc[to])) to++
  return { text: doc.slice(from, to), from, to }
}

/**
 * Whether the token sits where a command name goes: the first word of the
 * line, or the word right after a control character that starts a new
 * command (`|`, `;`, `&`, `(` — including `$(`). Everything else is an
 * argument.
 */
export function positionOf(doc: string, pos: number): TokenPosition {
  const token = tokenAt(doc, pos)
  // Walk back over whitespace to the previous word: `make; tes` and
  // `make ; tes` both put `tes` in command position.
  let i = token.from
  while (i > 0 && /\s/.test(doc[i - 1])) i--
  if (i === 0) return 'command'
  const before = doc[i - 1]
  if (before === '|' || before === ';' || before === '&' || before === '(') return 'command'
  return 'argument'
}

/**
 * Whether the token is a path form: contains a slash, or starts with `.` or
 * `~`. A bare word is a command name and is never offered as a path — the
 * deliberate scope line of the local path provider.
 */
export function looksLikePath(token: string): boolean {
  return token !== '' && (token.includes('/') || token.startsWith('.') || token.startsWith('~'))
}
