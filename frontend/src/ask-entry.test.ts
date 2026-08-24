// @vitest-environment jsdom
//
// The ONE seam that mints reference chips (nocx-a7mw7.1): every chip in the
// product goes through attachRegion(blockEl, rowStart, rowEnd) — the
// selection affordance today, the block menu's Attach output and the attach
// chord in later beads. chipFromSelection maps a live DOM selection to a
// frozen-region chip (or null when the selection cannot be one);
// attachRegion freezes a region into a chip; chipFingerprint is the
// exact-duplicate guard. A test names the seam here so a second minting
// path cannot appear unnoticed.
import { describe, expect, it } from 'vitest'
import { attachRegion, chipFingerprint, chipFromSelection } from './ask-entry'

/** A finished block in the DOM — the shape blocks.ts renders: a
 *  `.cmd-block` carrying `.cmd-header-text` and a `.cmd-output` of
 *  `.term-line` rows. */
function blockOf(
  command: string,
  lines: string[],
  opts: { running?: boolean; id?: string } = {},
): HTMLElement {
  const block = document.createElement('div')
  block.className = 'cmd-block'
  if (opts.running) block.classList.add('cmd-block-running')
  if (opts.id) block.dataset.blockId = opts.id
  const header = document.createElement('div')
  header.className = 'cmd-header-text'
  header.textContent = command
  const output = document.createElement('div')
  output.className = 'cmd-output'
  for (const text of lines) {
    const line = document.createElement('span')
    line.className = 'term-line'
    line.textContent = text
    output.appendChild(line)
  }
  block.append(header, output)
  return block
}

/** Select rows [start, end) of a block's output through the real document
 *  selection — the state chipFromSelection reads. */
function select(block: HTMLElement, start: number, end: number): Selection {
  const lines = block.querySelectorAll<HTMLElement>('.term-line')
  const range = document.createRange()
  range.setStart(lines[start].firstChild ?? lines[start], 0)
  range.setEnd(
    lines[end - 1].lastChild ?? lines[end - 1],
    (lines[end - 1].textContent ?? '').length,
  )
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  return sel
}

describe('attachRegion — the ONE chip-minting seam', () => {
  it('freezes a region into a chip with only its frozen coordinates', () => {
    const block = blockOf('ls', ['total 12', 'docs', 'orca'])
    const chip = attachRegion(block, 1, 3)
    expect(chip.blockEl).toBe(block)
    expect(chip.rowStart).toBe(1)
    expect(chip.rowEnd).toBe(3)
    expect('label' in chip).toBe(false)
  })

  it('keeps a single-row region as a one-row span', () => {
    const block = blockOf('git log', ['commit abc'])
    const chip = attachRegion(block, 0, 1)
    expect(chip.rowStart).toBe(0)
    expect(chip.rowEnd).toBe(1)
  })

  it('gives every chip a stable identity — two attachments are two chips, never one', () => {
    const block = blockOf('ls', ['total 12', 'docs'])
    const a = attachRegion(block, 0, 2)
    const b = attachRegion(block, 0, 2)
    expect(a.id).toMatch(/^ref-\d+$/)
    expect(a.id).not.toBe(b.id)
  })
})

describe('chipFromSelection — the predicate that decides whether a selection offers', () => {
  it("maps a selection inside one finished block's output to the covered row span", () => {
    const block = blockOf('ls', ['total 12', 'docs', 'orca'])
    document.body.appendChild(block)
    try {
      const chip = chipFromSelection(select(block, 1, 3))
      expect(chip).not.toBeNull()
      expect(chip!.blockEl).toBe(block)
      expect(chip!.rowStart).toBe(1)
      expect(chip!.rowEnd).toBe(3)
      // A single row is a single-row span.
      const one = chipFromSelection(select(block, 0, 1))
      expect(one?.rowStart).toBe(0)
      expect(one?.rowEnd).toBe(1)
    } finally {
      block.remove()
    }
  })

  it('refuses a collapsed selection and a null selection', () => {
    expect(chipFromSelection(null)).toBeNull()
    const block = blockOf('ls', ['total 12'])
    document.body.appendChild(block)
    try {
      const sel = select(block, 0, 1)
      sel.removeAllRanges()
      expect(chipFromSelection(sel)).toBeNull()
    } finally {
      block.remove()
    }
  })

  it('refuses a selection that crosses two blocks — there is no single frame', () => {
    const a = blockOf('ls', ['total 12'])
    const b = blockOf('git log', ['commit abc'])
    document.body.append(a, b)
    try {
      const linesA = a.querySelectorAll('.term-line')
      const linesB = b.querySelectorAll('.term-line')
      const range = document.createRange()
      range.setStart(linesA[0].firstChild ?? linesA[0], 0)
      range.setEnd(linesB[0].lastChild ?? linesB[0], (linesB[0].textContent ?? '').length)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      expect(chipFromSelection(sel)).toBeNull()
    } finally {
      a.remove()
      b.remove()
    }
  })

  it('refuses a selection inside a running block — its rows move', () => {
    const block = blockOf('sleep 1', ['working'], { running: true })
    document.body.appendChild(block)
    try {
      expect(chipFromSelection(select(block, 0, 1))).toBeNull()
    } finally {
      block.remove()
    }
  })
})

describe('chipFingerprint — the exact-duplicate guard', () => {
  it('is identical for the same block and rows, and distinct across rows', () => {
    const block = blockOf('ls', ['total 12', 'docs', 'orca'])
    const a = attachRegion(block, 1, 3)
    const b = attachRegion(block, 1, 3)
    expect(chipFingerprint(a)).toBe(chipFingerprint(b))
    const shorter = attachRegion(block, 1, 2)
    expect(chipFingerprint(a)).not.toBe(chipFingerprint(shorter))
  })

  it('separates blocks by their data-block-id, not by identity', () => {
    const a = blockOf('ls', ['total 12'], { id: 'b1' })
    const b = blockOf('ls', ['total 12'], { id: 'b2' })
    const chipA = attachRegion(a, 0, 1)
    const chipB = attachRegion(b, 0, 1)
    expect(chipFingerprint(chipA)).not.toBe(chipFingerprint(chipB))
  })
})
