// DOM scrollback serializer tests.
// Tests the 256-color palette, colorToCSS, attrsToStyle, and serializeLine.

import { describe, it, expect } from 'vitest'
import {
  paletteToRGB,
  colorToCSS,
  emptyAttrs,
  attrsEqual,
  attrsToStyle,
  serializeLine,
  serializeRange,
} from './serializer'
import { BufferLine } from './test-helpers'

// ── Minimal mock of xterm's IBufferLine ────────────────────────────────────

function makeLine(s: string): BufferLine {
  return new BufferLine(s)
}

describe('paletteToRGB', () => {
  it('returns ANSI colors for indices 0-15', () => {
    expect(paletteToRGB(0)).toBe('#1a1b26') // Black
    expect(paletteToRGB(1)).toBe('#f7768e') // Red
    expect(paletteToRGB(7)).toBe('#c0caf5') // White
    expect(paletteToRGB(15)).toBe('#c0caf5') // Bright White
  })

  it('returns 6×6×6 cube colors for indices 16-231', () => {
    // Index 16 = rgb(0,0,0) in cube = (0*40+55) for each
    expect(paletteToRGB(16)).toBe('rgb(0,0,0)')
    // Index 21 = 16+5 → (5,0,0) in cube coords: r=0,g=0,b=5 → 0,0,255
    expect(paletteToRGB(21)).toBe('rgb(0,0,255)')
    // Index 196 = red channel 5 = r=5*40+55=255,g=0,b=0
    expect(paletteToRGB(196)).toBe('rgb(255,0,0)')
    // Index 231 = white in cube = r=255,g=255,b=255
    expect(paletteToRGB(231)).toBe('rgb(255,255,255)')
  })

  it('returns grayscale ramp for indices 232-255', () => {
    expect(paletteToRGB(232)).toBe('rgb(8,8,8)')
    expect(paletteToRGB(255)).toBe('rgb(238,238,238)')
  })

  it('returns fallback for out-of-range indices', () => {
    expect(paletteToRGB(-1)).toBe('#c0caf5')
    expect(paletteToRGB(256)).toBe('#c0caf5')
  })
})

describe('colorToCSS', () => {
  it('returns null for mode 0 (default)', () => {
    expect(colorToCSS(7, 0)).toBeNull()
  })

  it('handles mode 1 (palette index)', () => {
    expect(colorToCSS(1, 1)).toBe('#f7768e') // Red
    expect(colorToCSS(7, 1)).toBe('#c0caf5') // White
  })

  it('handles mode 2 (24-bit RGB)', () => {
    // Color = 0x0000FF00 = green in RGB mode (0-7=R, 8-15=G, 16-23=B)
    expect(colorToCSS(0x0000ff00, 2)).toBe('rgb(0,255,0)')
  })

  it('returns null for unknown modes', () => {
    expect(colorToCSS(7, 3)).toBeNull()
  })
})

describe('emptyAttrs', () => {
  it('returns all-false/nulls', () => {
    const a = emptyAttrs()
    expect(a.fg).toBeNull()
    expect(a.bg).toBeNull()
    expect(a.bold).toBe(false)
    expect(a.inverse).toBe(false)
    expect(a.strikethrough).toBe(false)
  })
})

describe('attrsEqual', () => {
  it('returns true for two empty attrs', () => {
    expect(attrsEqual(emptyAttrs(), emptyAttrs())).toBe(true)
  })

  it('returns false when fg differs', () => {
    const a = emptyAttrs()
    const b = { ...emptyAttrs(), fg: '#ff0000' }
    expect(attrsEqual(a, b)).toBe(false)
  })

  it('returns false when bold differs', () => {
    const a = emptyAttrs()
    const b = { ...emptyAttrs(), bold: true }
    expect(attrsEqual(a, b)).toBe(false)
  })

  it('returns true when all fields match', () => {
    const a = {
      fg: '#fff',
      bg: '#000',
      bold: true,
      italic: false,
      underline: true,
      inverse: false,
      blink: false,
      strikethrough: false,
      overline: false,
    }
    const b = { ...a }
    expect(attrsEqual(a, b)).toBe(true)
  })
})

describe('attrsToStyle', () => {
  it('returns empty string for empty attrs', () => {
    expect(attrsToStyle(emptyAttrs())).toBe('')
  })

  it('includes foreground color', () => {
    const style = attrsToStyle({ ...emptyAttrs(), fg: '#ff0000' })
    expect(style).toContain('color:#ff0000')
  })

  it('includes background color', () => {
    const style = attrsToStyle({ ...emptyAttrs(), bg: '#0000ff' })
    expect(style).toContain('background:#0000ff')
  })

  it('includes bold', () => {
    const style = attrsToStyle({ ...emptyAttrs(), bold: true })
    expect(style).toContain('font-weight:bold')
  })

  it('includes italic', () => {
    const style = attrsToStyle({ ...emptyAttrs(), italic: true })
    expect(style).toContain('font-style:italic')
  })

  it('includes underline', () => {
    const style = attrsToStyle({ ...emptyAttrs(), underline: true })
    expect(style).toContain('text-decoration:underline')
  })

  it('includes strikethrough', () => {
    const style = attrsToStyle({ ...emptyAttrs(), strikethrough: true })
    expect(style).toContain('text-decoration:line-through')
  })

  it('combines underline and strikethrough', () => {
    const style = attrsToStyle({ ...emptyAttrs(), underline: true, strikethrough: true })
    expect(style).toContain('text-decoration:underline line-through')
  })

  it('swaps fg/bg on inverse', () => {
    const style = attrsToStyle({ ...emptyAttrs(), fg: '#ff0000', bg: '#0000ff', inverse: true })
    expect(style).toContain('color:#0000ff')
    expect(style).toContain('background:#ff0000')
  })

  it('handles inverse with only fg', () => {
    const style = attrsToStyle({ ...emptyAttrs(), fg: '#ff0000', inverse: true })
    expect(style).toContain('color:#1a1b26') // bg becomes default bg
    expect(style).toContain('background:#ff0000')
  })

  it('handles inverse with only bg', () => {
    const style = attrsToStyle({ ...emptyAttrs(), bg: '#00ff00', inverse: true })
    expect(style).toContain('color:#00ff00')
    expect(style).toContain('background:#c0caf5') // fg becomes default fg
  })

  it('includes overline', () => {
    const style = attrsToStyle({ ...emptyAttrs(), overline: true })
    expect(style).toContain('text-decoration:overline')
  })

  it('combines underline with overline', () => {
    const style = attrsToStyle({ ...emptyAttrs(), underline: true, overline: true })
    expect(style).toContain('text-decoration:underline overline')
  })
})

describe('serializeLine', () => {
  it('returns empty line for undefined', () => {
    expect(serializeLine(undefined)).toBe('<span class="term-line"></span>')
  })

  it('handles empty line', () => {
    const line = makeLine('')
    const html = serializeLine(line)
    expect(html).toBe('<span class="term-line"></span>')
  })

  it('wraps plain text', () => {
    const line = makeLine('hello')
    const html = serializeLine(line)
    expect(html).toBe('<span class="term-line">hello</span>')
  })

  it('escapes HTML entities', () => {
    const line = makeLine('<script>alert("xss")</script>')
    const html = serializeLine(line)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('escapes ampersands', () => {
    const line = makeLine('a & b')
    const html = serializeLine(line)
    expect(html).toContain('a &amp; b')
  })
})

describe('serializeRange', () => {
  it('trims trailing empty lines (no dangling empty term-line at block bottom)', () => {
    const lines = [makeLine('output'), makeLine(''), makeLine('')]
    const html = serializeRange((y) => lines[y], 0, 2)
    expect(html).toBe('<span class="term-line">output</span>')
  })

  it('preserves interior blank lines', () => {
    const lines = [makeLine('a'), makeLine(''), makeLine('b'), makeLine('')]
    const html = serializeRange((y) => lines[y], 0, 3)
    expect(html).toBe(
      '<span class="term-line">a</span><span class="term-line"></span><span class="term-line">b</span>',
    )
  })

  it('returns empty string when every line is empty', () => {
    const lines = [makeLine(''), makeLine('')]
    expect(serializeRange((y) => lines[y], 0, 1)).toBe('')
  })
})

describe('serializeRange reflow (isWrapped)', () => {
  it('joins soft-wrapped physical lines into one logical line', () => {
    const lines = [
      new BufferLine('Quick safety check: is this a', false),
      new BufferLine('project you created?', true), // continuation
      new BufferLine('', false),
    ]
    const html = serializeRange((y) => lines[y], 0, 2)
    expect(html).toBe(
      '<span class="term-line">Quick safety check: is this aproject you created?</span>',
    )
  })

  it('keeps hard newlines (table rows) as separate lines', () => {
    const lines = [new BufferLine('PID TTY', false), new BufferLine('123 pts/1', false)]
    const html = serializeRange((y) => lines[y], 0, 1)
    expect(html).toBe(
      '<span class="term-line">PID TTY</span><span class="term-line">123 pts/1</span>',
    )
  })

  it('keeps the trailing space of a full soft-wrapped line', () => {
    const lines = [
      new BufferLine('word ', false), // full line, wraps at the space
      new BufferLine('next', true),
    ]
    const html = serializeRange((y) => lines[y], 0, 1)
    expect(html).toBe('<span class="term-line">word next</span>')
  })

  it('trims trailing empty logical lines after reflow', () => {
    const lines = [new BufferLine('a', false), new BufferLine('', false), new BufferLine('', false)]
    expect(serializeRange((y) => lines[y], 0, 2)).toBe('<span class="term-line">a</span>')
  })
})
