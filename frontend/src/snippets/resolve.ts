// Resolution happens at fire time, once, whatever the destination. CM6 ships
// snippet tab-stops and they were tempting for `ask:` in the editor with a
// form elsewhere — rejected, because that is two implementations of "fill in
// the blanks" that would agree in every case anyone tried. Design §8.
import { findReferences } from '../secret-reference'
import { findSnippetSpans } from './reference'
import type { SessionFacts } from './session-facts'

export type { SessionFacts } from './session-facts'

export interface AskField {
  readonly name: string
  readonly defaultValue: string
}

export type ResolveOutcome =
  | { kind: 'resolved'; text: string }
  | { kind: 'needs-fields'; fields: AskField[] }
  | { kind: 'refused'; reason: 'env-unavailable'; keys: string[] }

/** `port=8080` → name `port`, default `8080`. `port` → default ''. Only the
 *  FIRST `=` separates, so a default may contain one. Exported because the
 *  settings page's preview reports the same field the fire will ask for,
 *  and a second split is a second grammar (AD-8). */
export function splitAsk(arg: string): AskField {
  const at = arg.indexOf('=')
  if (at < 0) return { name: arg, defaultValue: '' }
  return { name: arg.slice(0, at), defaultValue: arg.slice(at + 1) }
}

/** The distinct fields a body asks for, in first-occurrence order. One entry
 *  per NAME: the same name twice is one question and two substitutions. */
export function askFields(body: string): AskField[] {
  const out: AskField[] = []
  const seen = new Set<string>()
  for (const span of findSnippetSpans(body)) {
    if (span.ns !== 'ask') continue
    const field = splitAsk(span.arg)
    if (seen.has(field.name)) continue
    seen.add(field.name)
    out.push(field)
  }
  return out
}

/** True when the text carries a vault reference. Read-only use of the vault's
 *  own scan — this module never resolves one. */
export function hasSecretReference(text: string): boolean {
  return findReferences(text).length > 0
}

/** The closed env table (design §7.4) — extended by adding a row, never by a
 *  parameter or a mode flag (AD-8). A key that is not a row cannot be
 *  answered, exactly like a null fact.
 *
 *  The value of each row is what the settings page's preview line says the
 *  key will become. It is a phrase rather than a live value on purpose: the
 *  facts are the ACTIVE PANE's and are read at fire time, and while the
 *  settings tab is in front there is no pane to read — a preview showing
 *  "unavailable" there would be a statement about the wrong moment. */
export const ENV_KEYS = {
  cwd: "the pane's working directory",
  host: "the pane's host",
  user: "the session's user",
  branch: 'the checked-out git branch',
} as const

export type EnvKey = keyof typeof ENV_KEYS

function envValue(key: string, facts: SessionFacts): string | null {
  return key in ENV_KEYS ? facts[key as EnvKey] : null
}

export function resolveBody(
  body: string,
  facts: SessionFacts,
  answers: ReadonlyMap<string, string>,
): ResolveOutcome {
  const spans = findSnippetSpans(body)
  if (spans.length === 0) return { kind: 'resolved', text: body }

  const pending = askFields(body).filter((f) => !answers.has(f.name))
  if (pending.length > 0) return { kind: 'needs-fields', fields: pending }

  // Collect every unavailable env key BEFORE substituting anything, so the
  // refusal names all of them and nothing partial is ever produced. A span
  // repeats an arg only when the body names the same key twice; deduplicating
  // keeps the keys list as short as the question is.
  const missing: string[] = []
  const seen = new Set<string>()
  for (const span of spans) {
    if (span.ns !== 'env') continue
    if (envValue(span.arg, facts) === null && !seen.has(span.arg)) {
      seen.add(span.arg)
      missing.push(span.arg)
    }
  }
  if (missing.length > 0) return { kind: 'refused', reason: 'env-unavailable', keys: missing }

  // Substitute right-to-left so earlier offsets stay valid.
  let text = body
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]
    const value =
      span.ns === 'env'
        ? (envValue(span.arg, facts) ?? '')
        : (answers.get(splitAsk(span.arg).name) ?? '')
    text = text.slice(0, span.from) + value + text.slice(span.to)
  }
  return { kind: 'resolved', text }
}
