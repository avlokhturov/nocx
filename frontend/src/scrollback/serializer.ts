// DOM scrollback: xterm buffer → HTML serializer.
// Iterates IBufferLine cells, maps 256-color + RGB + attributes into inline
// styles, and merges adjacent cells with identical attributes into a single
// run. Output is an HTML fragment string — assigned via innerHTML on the
// frozen block output element.

import type { IBufferLine } from '@xterm/xterm'

// ── 256-color palette ─────────────────────────────────────────────────────

// ANSI 0-15 mapped to Tokyo Night theme (matching xterm theme in xterm.ts).
const ANSI_COLORS: readonly string[] = [
  '#1a1b26', // 0  Black
  '#f7768e', // 1  Red
  '#9ece6a', // 2  Green
  '#e0af68', // 3  Yellow
  '#7aa2f7', // 4  Blue
  '#bb9af7', // 5  Magenta
  '#7dcfff', // 6  Cyan
  '#c0caf5', // 7  White
  '#565f89', // 8  Bright Black
  '#f7768e', // 9  Bright Red
  '#9ece6a', // 10 Bright Green
  '#e0af68', // 11 Bright Yellow
  '#7aa2f7', // 12 Bright Blue
  '#bb9af7', // 13 Bright Magenta
  '#7dcfff', // 14 Bright Cyan
  '#c0caf5', // 15 Bright White
]

/**
 * Maps a 256-color palette index to a CSS color string.
 * - 0-15: ANSI colors (Tokyo Night theme)
 * - 16-231: 6×6×6 color cube
 * - 232-255: grayscale ramp
 */
export function paletteToRGB(idx: number): string {
  if (idx < 0 || idx > 255) return '#c0caf5' // fallback to default foreground
  if (idx < 16) return ANSI_COLORS[idx]
  if (idx < 232) {
    const i = idx - 16
    const r = Math.floor(i / 36)
    const g = Math.floor((i % 36) / 6)
    const b = i % 6
    const scale = (v: number) => (v === 0 ? 0 : v * 40 + 55)
    return `rgb(${scale(r)},${scale(g)},${scale(b)})`
  }
  const g = (idx - 232) * 10 + 8
  return `rgb(${g},${g},${g})`
}

/**
 * Maps an xterm color (mode + color) to a CSS color string, or null for default.
 * - mode 0: default terminal color (inherit via CSS)
 * - mode 1: 256-color palette index
 * - mode 2: 24-bit RGB (bits 0-7=R, 8-15=G, 16-23=B)
 */
export function colorToCSS(color: number, mode: number): string | null {
  if (mode === 0) return null
  if (mode === 2) {
    const r = color & 0xff
    const g = (color >> 8) & 0xff
    const b = (color >> 16) & 0xff
    return `rgb(${r},${g},${b})`
  }
  if (mode === 1) return paletteToRGB(color)
  return null
}

// ── Cell attributes ────────────────────────────────────────────────────────

export interface CellAttrs {
  fg: string | null
  bg: string | null
  bold: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  blink: boolean
  strikethrough: boolean
  overline: boolean
}

export function emptyAttrs(): CellAttrs {
  return {
    fg: null,
    bg: null,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    blink: false,
    strikethrough: false,
    overline: false,
  }
}

export function attrsEqual(a: CellAttrs, b: CellAttrs): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.blink === b.blink &&
    a.strikethrough === b.strikethrough &&
    a.overline === b.overline
  )
}

/**
 * Extract cell attributes from an xterm buffer cell.
 * Works with xterm.js 5.x IBufferLine / ICell interfaces.
 */
export function cellAttrs(line: IBufferLine, cellIdx: number): CellAttrs {
  const cell = line.getCell(cellIdx)
  if (!cell) return emptyAttrs()

  const fgColor = cell.getFgColor()
  const fgMode = cell.getFgColorMode()
  const bgColor = cell.getBgColor()
  const bgMode = cell.getBgColorMode()

  return {
    fg: colorToCSS(fgColor, fgMode),
    bg: colorToCSS(bgColor, bgMode),
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    inverse: cell.isInverse() !== 0,
    blink: cell.isBlink() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
    overline: cell.isOverline() !== 0,
  }
}

/**
 * Build a CSS style string from a CellAttrs record.
 * Inverse mode swaps foreground and background colors.
 */
export function attrsToStyle(a: CellAttrs): string {
  const parts: string[] = []
  let effectiveFg = a.fg
  let effectiveBg = a.bg

  if (a.inverse) {
    // Swap: original fg → bg, original bg → fg.
    // When a side is null (default), use the terminal's default color.
    effectiveFg = a.bg ?? '#1a1b26'
    effectiveBg = a.fg ?? '#c0caf5'
  }

  if (effectiveFg) parts.push(`color:${effectiveFg}`)
  if (effectiveBg) parts.push(`background:${effectiveBg}`)
  if (a.bold) parts.push('font-weight:bold')
  if (a.italic) parts.push('font-style:italic')
  if (a.underline && !a.strikethrough) parts.push('text-decoration:underline')
  if (a.strikethrough && !a.underline) parts.push('text-decoration:line-through')
  if (a.underline && a.strikethrough) parts.push('text-decoration:underline line-through')
  if (a.overline) {
    if (parts.some((s) => s.startsWith('text-decoration:'))) {
      // Append to existing text-decoration
      const idx = parts.findIndex((s) => s.startsWith('text-decoration:'))
      if (idx >= 0) parts[idx] += ' overline'
      else parts.push('text-decoration:overline')
    } else {
      parts.push('text-decoration:overline')
    }
  }

  return parts.join(';')
}

// ── Run merging ────────────────────────────────────────────────────────────

interface Run {
  chars: string
  attrs: CellAttrs
}

/**
 * Collects consecutive cells with identical attributes into runs.
 * Handles wide characters (CJK) by their cell width.
 * keepTrailingSpace: a soft-wrapped line is FULL by definition (that is why
 * it wrapped), so its trailing chars are real content, not xterm padding —
 * the caller passes true for every physical line that has a continuation.
 */
function collectRuns(line: IBufferLine, keepTrailingSpace = false): Run[] {
  const len = line.length
  if (len === 0) return []

  const runs: Run[] = []
  let i = 0

  while (i < len) {
    const cell = line.getCell(i)
    if (!cell) {
      i++
      continue
    }

    const width = cell.getWidth()
    const chars = cell.getChars()

    if (chars.length === 0) {
      // Empty cell → space
      const attrs = cellAttrs(line, i)
      if (runs.length > 0 && attrsEqual(runs[runs.length - 1].attrs, attrs)) {
        runs[runs.length - 1].chars += ' '
      } else {
        runs.push({ chars: ' ', attrs })
      }
      i += Math.max(1, width)
      continue
    }

    // Escape HTML entities in the cell characters
    const escaped = chars.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    const attrs = cellAttrs(line, i)

    if (runs.length > 0 && attrsEqual(runs[runs.length - 1].attrs, attrs)) {
      runs[runs.length - 1].chars += escaped
    } else {
      runs.push({ chars: escaped, attrs })
    }
    i += Math.max(1, width)
  }

  // Strip trailing spaces from the last run only (xterm pads lines).
  // We keep interior spaces — they're from the actual command output.
  if (!keepTrailingSpace && runs.length > 0) {
    const last = runs[runs.length - 1]
    last.chars = last.chars.replace(/ +$/, '')
  }

  return runs
}

// ── Serialization ──────────────────────────────────────────────────────────

/**
 * Serialize a single buffer line to an HTML string (a <span class="term-line">
 * containing run-merged <span> elements).
 */
export function serializeLine(line: IBufferLine | undefined): string {
  if (!line) return '<span class="term-line"></span>'

  const runs = collectRuns(line)

  if (runs.length === 0) {
    return '<span class="term-line"></span>'
  }

  // Check if there's any non-empty content after trailing space trim
  const hasContent = runs.some((r) => r.chars.length > 0)
  if (!hasContent) {
    return '<span class="term-line"></span>'
  }

  let html = '<span class="term-line">'
  for (const run of runs) {
    if (run.chars.length === 0) continue
    const style = attrsToStyle(run.attrs)
    if (style) {
      html += `<span style="${style}">${run.chars}</span>`
    } else {
      html += run.chars
    }
  }
  html += '</span>'
  return html
}

/**
 * Serialize a range of buffer lines (inclusive [startLine, endLine]) into a
 * single HTML string.
 *
 * REFLOW (owner directive): physical lines that xterm soft-wrapped at the
 * PTY grid width (IBufferLine.isWrapped on the CONTINUATION line) are
 * joined back into one logical line — one <span class="term-line"> per
 * logical line. The wrap the application was forced into at print time is
 * NOT baked into the block; CSS re-wraps naturally at the block's actual
 * width, so frozen output reflows cleanly on window resize. Hard newlines
 * (table rows, ls output) are untouched.
 *
 * Trailing EMPTY logical lines are trimmed: the range typically ends at the
 * D-marker line (an empty prompt-again row), and a dangling empty term-line
 * at the bottom of every block renders as stray blank space. Interior blank
 * lines are preserved — they are real output spacing.
 */
export function serializeRange(
  getLine: (y: number) => IBufferLine | undefined,
  startLine: number,
  endLine: number,
): string {
  // Group physical lines into logical lines by the isWrapped continuation
  // flag, then serialize each group into one term-line span.
  const groups: string[] = []
  for (let y = startLine; y <= endLine; y++) {
    const line = getLine(y)
    const continuation = line?.isWrapped === true && groups.length > 0
    if (!line) {
      groups.push('')
      continue
    }
    const runs = collectRuns(line, continuation || (getLine(y + 1)?.isWrapped ?? false))
    let content = ''
    for (const run of runs) {
      if (run.chars.length === 0) continue
      const style = attrsToStyle(run.attrs)
      content += style ? `<span style="${style}">${run.chars}</span>` : run.chars
    }
    if (continuation) {
      groups[groups.length - 1] += content
    } else {
      groups.push(content)
    }
  }
  while (groups.length > 0 && groups[groups.length - 1] === '') {
    groups.pop()
  }
  return groups.map((g) => `<span class="term-line">${g}</span>`).join('')
}
