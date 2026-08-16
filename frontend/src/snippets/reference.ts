// The snippets half of the {{ns:arg}} grammar: env and ask, never secret.
// The grammar rules are inherited from the vault's scan because they were
// bought there — the arg is open (spaces are legal), only `}` is structural,
// and a malformed span matches nothing. The namespace registry lives in
// reference-namespaces.ts; this module deliberately does not re-export it,
// so each export here has exactly one home.

/** The namespaces THIS scan owns. A closed alternation, so an unknown
 *  namespace matches nothing anywhere and stays visible as literal text. */
export const SNIPPET_REFERENCE_RE = /\{\{(env|ask):([^}]*)\}\}/g

export interface SnippetSpan {
  from: number
  to: number
  ns: 'env' | 'ask'
  arg: string
}

/** Every well-formed env/ask span in `input`, in first-occurrence order.
 *  Offsets are UTF-16 code-unit positions — what CM6 uses. */
export function findSnippetSpans(input: string): SnippetSpan[] {
  const out: SnippetSpan[] = []
  for (const m of input.matchAll(SNIPPET_REFERENCE_RE)) {
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      ns: m[1] as 'env' | 'ask',
      arg: m[2],
    })
  }
  return out
}
