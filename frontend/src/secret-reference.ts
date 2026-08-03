// The reference grammar, one scan shared by every consumer: the chip
// decorates the spans, planSubmit decides whether a line needs resolving,
// and the offer must never treat a reference's NAME as a secret.
//
// {{secret:NAME}} — NAME is the vault inventory name (ADR-0016). The
// grammar is deliberately open (spaces are legal — internal/secrets tests
// `echo {{secret:with space in name}}`); only `}` is structural.
export const REFERENCE_RE = /\{\{secret:([^}]*)\}\}/g

/** One {{secret:NAME}} reference span in `input`, in first-occurrence
 *  order. Offsets are UTF-16 code-unit positions — what CM6 uses. */
export interface ReferenceSpan {
  from: number
  to: number
  name: string
}

/** Find every well-formed reference in `input`. A malformed span (a `}`
 *  inside the name) matches nothing — the chip must never decorate it. */
export function findReferences(input: string): ReferenceSpan[] {
  const out: ReferenceSpan[] = []
  for (const m of input.matchAll(REFERENCE_RE)) {
    out.push({ from: m.index, to: m.index + m[0].length, name: m[1] })
  }
  return out
}
