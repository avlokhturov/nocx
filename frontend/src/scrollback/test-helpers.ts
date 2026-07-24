// Test helper: minimal xterm IBufferLine/Cell mock for serializer tests.
// Implements enough of the xterm interface for the serializer's cellAttrs
// and serializeLine functions.

import type { IBufferLine, IBufferCell } from '@xterm/xterm'

interface MockCellData {
  chars: string
  width: number
  fg: number
  fgMode: number
  bg: number
  bgMode: number
  bold: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  blink: boolean
  strikethrough: boolean
  overline: boolean
}

function defaultCell(ch: string, width: number = 1): MockCellData {
  return {
    chars: ch,
    width,
    fg: 0,
    fgMode: 0, // default (inherit) — no color spans for plain text
    bg: 0,
    bgMode: 0, // default
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    blink: false,
    strikethrough: false,
    overline: false,
  }
}

/** Create a mock IBufferCell from MockCellData. */
function toBufferCell(d: MockCellData): IBufferCell {
  return {
    getChars: () => d.chars,
    getWidth: () => d.width,
    getCode: () => d.chars.codePointAt(0) ?? 0,
    getFgColor: () => d.fg,
    getFgColorMode: () => d.fgMode,
    getBgColor: () => d.bg,
    getBgColorMode: () => d.bgMode,
    isBold: () => (d.bold ? 1 : 0),
    isItalic: () => (d.italic ? 1 : 0),
    isDim: () => 0,
    isUnderline: () => (d.underline ? 1 : 0),
    isBlink: () => (d.blink ? 1 : 0),
    isInverse: () => (d.inverse ? 1 : 0),
    isInvisible: () => 0,
    isStrikethrough: () => (d.strikethrough ? 1 : 0),
    isOverline: () => (d.overline ? 1 : 0),
    isFgRGB: () => d.fgMode === 2,
    isBgRGB: () => d.bgMode === 2,
    isFgPalette: () => d.fgMode === 1,
    isBgPalette: () => d.bgMode === 1,
    isFgDefault: () => d.fgMode === 0,
    isBgDefault: () => d.bgMode === 0,
    isAttributeDefault: () => false,
  }
}

/**
 * Minimal IBufferLine mock.
 */
export class BufferLine implements IBufferLine {
  private _cells: MockCellData[]
  readonly isWrapped: boolean
  readonly length: number

  constructor(content: string | MockCellData[], isWrapped = false) {
    if (typeof content === 'string') {
      this._cells = [...content].map((ch) => defaultCell(ch, 1))
    } else {
      this._cells = content
    }
    this.isWrapped = isWrapped
    this.length = this._cells.length
  }

  getCell(x: number): IBufferCell | undefined {
    if (x < 0 || x >= this._cells.length) return undefined
    return toBufferCell(this._cells[x])
  }

  translateToString(trimRight?: boolean, startCol?: number, endCol?: number): string {
    const s = startCol ?? 0
    const e = endCol ?? this.length
    const result = this._cells
      .slice(s, e)
      .map((c) => c.chars)
      .join('')
    return trimRight ? result.replace(/ +$/, '') : result
  }
}

/**
 * Builder for constructing styled lines.
 */
export function lineWith(
  ...specs: Array<{
    chars: string
    bold?: boolean
    fg?: number
    bg?: number
    fgMode?: number
    bgMode?: number
    italic?: boolean
    underline?: boolean
    inverse?: boolean
    width?: number
  }>
): BufferLine {
  const cells: MockCellData[] = specs.map((s) => ({
    chars: s.chars,
    width: s.width ?? 1,
    fg: s.fg ?? 7,
    fgMode: s.fgMode ?? 1,
    bg: s.bg ?? 0,
    bgMode: s.bgMode ?? 1,
    bold: s.bold ?? false,
    italic: s.italic ?? false,
    underline: s.underline ?? false,
    inverse: s.inverse ?? false,
    blink: false,
    strikethrough: false,
    overline: false,
  }))
  return new BufferLine(cells)
}
