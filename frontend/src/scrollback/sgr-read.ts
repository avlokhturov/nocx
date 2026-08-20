// SGR -> the serializer's attributes (nocx-cjct0, design §6): the inverse of
// sgr.ts, and the half restore needs.
//
// WHAT THIS IS NOT: a VT parser. It reads the sequences sgr.ts writes — SGR
// and nothing else — over text with no cursor movement, no erase and no
// alternate buffer in it, because the body it reads was produced from cells
// that had already been laid out. A body carrying anything else is a body
// this module did not write, and the unknown-parameter rule below is what it
// does about that: ignore the parameter, keep the text. A restored block
// showing an escape sequence as literal text is a worse answer than one
// missing an attribute.
//
// The mapping from attributes to inline styles is NOT here. That is
// serializer.ts's and it stays there: one owner of how a block looks, reached
// from two directions — live cells on one side, a stored body on the other.
import { emptyAttrs, colorToCSS, type CellAttrs, type TerminalSnapshot } from './serializer'

/** One run of a restored row: its characters and the attributes in force. */
export interface RestoredRun {
  chars: string
  attrs: CellAttrs
}

/** ESC [ ... m, and only that. Anything else is left in the text, which is
 *  the honest failure: the block then says what the body says. */
// eslint-disable-next-line no-control-regex
const SGR_RE = /\u001b\[([0-9;]*)m/g

/**
 * Apply one parameter list to `attrs`, in place.
 *
 * The parameters are read IN ORDER, because SGR is a sequence of
 * instructions and not a set: `0;31` is "reset, then red" while `31;0` is
 * "red, then reset", which is not red. The extended forms consume their own
 * parameters as they go, for the same reason.
 */
function applyParams(snapshot: TerminalSnapshot, attrs: CellAttrs, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) {
      Object.assign(attrs, emptyAttrs())
    } else if (p === 1) {
      attrs.bold = true
    } else if (p === 2) {
      attrs.dim = true
    } else if (p === 3) {
      attrs.italic = true
    } else if (p === 4) {
      attrs.underline = true
    } else if (p === 5) {
      attrs.blink = true
    } else if (p === 7) {
      attrs.inverse = true
    } else if (p === 9) {
      attrs.strikethrough = true
    } else if (p === 53) {
      attrs.overline = true
    } else if (p === 22) {
      attrs.bold = false
      attrs.dim = false
    } else if (p === 23) {
      attrs.italic = false
    } else if (p === 24) {
      attrs.underline = false
    } else if (p === 25) {
      attrs.blink = false
    } else if (p === 27) {
      attrs.inverse = false
    } else if (p === 29) {
      attrs.strikethrough = false
    } else if (p === 55) {
      attrs.overline = false
    } else if (p >= 30 && p <= 37) {
      attrs.fg = colorToCSS(snapshot, p - 30, 1)
    } else if (p >= 90 && p <= 97) {
      attrs.fg = colorToCSS(snapshot, p - 90 + 8, 1)
    } else if (p === 39) {
      attrs.fg = null
    } else if (p >= 40 && p <= 47) {
      attrs.bg = colorToCSS(snapshot, p - 40, 1)
    } else if (p >= 100 && p <= 107) {
      attrs.bg = colorToCSS(snapshot, p - 100 + 8, 1)
    } else if (p === 49) {
      attrs.bg = null
    } else if (p === 38 || p === 48) {
      // 38;5;N or 38;2;R;G;B. A truncated form consumes what is there and
      // sets nothing: half a colour is not a colour.
      const target = p === 38 ? 'fg' : 'bg'
      const mode = params[i + 1]
      if (mode === 5 && i + 2 < params.length) {
        attrs[target] = colorToCSS(snapshot, params[i + 2], 1)
        i += 2
      } else if (mode === 2 && i + 4 < params.length) {
        const packed = (params[i + 2] << 16) | (params[i + 3] << 8) | params[i + 4]
        attrs[target] = colorToCSS(snapshot, packed, 2)
        i += 4
      } else {
        i = params.length
      }
    }
    // Anything else is an attribute we do not model, ignored on purpose: the
    // text is what the person came for, and a parameter nobody reads is not
    // worth losing a block over.
  }
}

/** Split one row of a stored body into its runs. An empty parameter list —
 *  ESC[m — is 0, which is what a terminal does with it. */
export function runsFromSGR(snapshot: TerminalSnapshot, row: string): RestoredRun[] {
  const runs: RestoredRun[] = []
  const attrs = emptyAttrs()
  let at = 0
  SGR_RE.lastIndex = 0
  for (let m = SGR_RE.exec(row); m !== null; m = SGR_RE.exec(row)) {
    if (m.index > at) runs.push({ chars: row.slice(at, m.index), attrs: { ...attrs } })
    const raw = m[1] === '' ? [0] : m[1].split(';').map((n) => (n === '' ? 0 : Number(n)))
    applyParams(snapshot, attrs, raw)
    at = m.index + m[0].length
  }
  if (at < row.length) runs.push({ chars: row.slice(at), attrs: { ...attrs } })
  return runs
}
