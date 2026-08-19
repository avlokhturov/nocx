// SGR emission tests (nocx-2f0f, design §3): the durable body keeps colour as
// the program named it, not as the palette that happened to be current.

import { describe, it, expect } from 'vitest'
import { sgrParams, emptySGR, cellSGRAttrs, sgrEqual, type SGRAttrs } from './sgr'
import { lineWith, XTERM_CM_P16, XTERM_CM_P256, XTERM_CM_RGB } from './test-helpers'

const attrs = (over: Partial<SGRAttrs>): SGRAttrs => ({ ...emptySGR(), ...over })

describe('sgrParams', () => {
  it('opens a 16-colour foreground and closes it again', () => {
    const red = attrs({ fg: { mode: 1, color: 1 } })
    expect(sgrParams(emptySGR(), red)).toBe('\x1b[31m')
    expect(sgrParams(red, emptySGR())).toBe('\x1b[39m')
  })

  it('emits a bright colour, a 256-palette index and a 24-bit colour in their own forms', () => {
    expect(sgrParams(emptySGR(), attrs({ fg: { mode: 1, color: 9 } }))).toBe('\x1b[91m')
    expect(sgrParams(emptySGR(), attrs({ fg: { mode: 1, color: 208 } }))).toBe('\x1b[38;5;208m')
    expect(sgrParams(emptySGR(), attrs({ fg: { mode: 2, color: 0xff8800 } }))).toBe(
      '\x1b[38;2;255;136;0m',
    )
  })

  it('puts a background on the 40 range', () => {
    expect(sgrParams(emptySGR(), attrs({ bg: { mode: 1, color: 4 } }))).toBe('\x1b[44m')
  })

  it('adds an attribute without reopening the colour', () => {
    const red = attrs({ fg: { mode: 1, color: 1 } })
    const redBold = attrs({ fg: { mode: 1, color: 1 }, bold: true })
    expect(sgrParams(red, redBold)).toBe('\x1b[1m')
  })

  it('resets and reopens when an attribute goes off', () => {
    const redBold = attrs({ fg: { mode: 1, color: 1 }, bold: true })
    const red = attrs({ fg: { mode: 1, color: 1 } })
    expect(sgrParams(redBold, red)).toBe('\x1b[0;31m')
  })

  it('says nothing when nothing changed', () => {
    const red = attrs({ fg: { mode: 1, color: 1 } })
    expect(sgrParams(red, red)).toBe('')
    expect(sgrParams(emptySGR(), emptySGR())).toBe('')
  })
})

describe('cellSGRAttrs', () => {
  it('reads the RAW colour, not one resolved against a palette', () => {
    const line = lineWith(
      { chars: 'a', fg: 1, fgMode: XTERM_CM_P16 },
      { chars: 'b', fg: 208, fgMode: XTERM_CM_P256 },
      { chars: 'c', fg: 0xff8800, fgMode: XTERM_CM_RGB },
    )
    expect(cellSGRAttrs(line, 0).fg).toEqual({ mode: 1, color: 1 })
    expect(cellSGRAttrs(line, 1).fg).toEqual({ mode: 1, color: 208 })
    expect(cellSGRAttrs(line, 2).fg).toEqual({ mode: 2, color: 0xff8800 })
  })

  it('reports the terminal default as no colour at all', () => {
    const line = lineWith({ chars: 'a', fgMode: 0, bgMode: 0 })
    expect(cellSGRAttrs(line, 0).fg).toBeNull()
    expect(cellSGRAttrs(line, 0).bg).toBeNull()
  })

  it('carries the attribute flags', () => {
    const line = lineWith({ chars: 'a', bold: true, underline: true })
    const a = cellSGRAttrs(line, 0)
    expect(a.bold).toBe(true)
    expect(a.underline).toBe(true)
    expect(a.italic).toBe(false)
  })

  it('is empty for a cell that is not there', () => {
    const line = lineWith({ chars: 'a' })
    expect(sgrEqual(cellSGRAttrs(line, 5), emptySGR())).toBe(true)
  })
})
