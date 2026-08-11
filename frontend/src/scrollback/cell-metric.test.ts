// @vitest-environment jsdom
// Cell-metric publisher (nocx-yy9g): the renderer's real cell width is
// published to the scrollback container as custom properties the frozen
// block layout consumes. jsdom computes no layout, so the natural-advance
// measurement is stubbed here — these tests pin the plumbing (the metric is
// fetched, published, applied; 0/unmeasurable publishes nothing); only a
// real browser can confirm the pixel geometry (see the task report).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureNaturalAdvance, publishCellMetric, type CellMetric } from './cell-metric'

const WIDTH_ONLY = { width: 640, height: 16 } as DOMRect

function stubProbeRect(container: HTMLElement, rect: DOMRect): HTMLElement {
  // publishCellMetric creates the probe lazily; create it the way the
  // module does so the test can stub its measurement.
  const probe = container.querySelector<HTMLElement>('.cell-metric-probe')
  const el =
    probe ??
    (() => {
      const p = document.createElement('span')
      p.className = 'cell-metric-probe'
      p.textContent = 'W'.repeat(64)
      container.appendChild(p)
      return p
    })()
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect)
  return el
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('measureNaturalAdvance', () => {
  it('measures the probe width divided by its character count', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    stubProbeRect(container, { width: 640, height: 16 } as DOMRect)
    // 64 W's at 10px each = 640px.
    expect(measureNaturalAdvance(container)).toBe(10)
  })

  it('reuses one probe across calls', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    stubProbeRect(container, WIDTH_ONLY)
    measureNaturalAdvance(container)
    measureNaturalAdvance(container)
    expect(container.querySelectorAll('.cell-metric-probe')).toHaveLength(1)
  })

  it('returns 0 when the probe has no measurable width (jsdom has no layout)', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    expect(measureNaturalAdvance(container)).toBe(0)
  })
})

describe('publishCellMetric', () => {
  it('publishes the cell width and the per-character correction', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const measure = vi.fn(() => 8.4) // the DOM's natural advance
    const metric = publishCellMetric(container, 8.5, measure)
    expect(metric).toEqual<CellMetric>({
      cellWidth: 8.5,
      naturalAdvance: 8.4,
      delta: 0.1,
    })
    expect(container.style.getPropertyValue('--term-cell-width')).toBe('8.5px')
    expect(container.style.getPropertyValue('--term-cell-delta')).toBe('0.1px')
  })

  it('handles a negative delta — the DOM running WIDER than the grid', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const metric = publishCellMetric(container, 8.5, () => 8.8)
    expect(metric?.delta).toBe(-0.3)
    expect(container.style.getPropertyValue('--term-cell-delta')).toBe('-0.3px')
  })

  it('publishes nothing while the renderer cannot measure (cellWidth 0)', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const measure = vi.fn(() => 8.4)
    expect(publishCellMetric(container, 0, measure)).toBeNull()
    expect(container.style.getPropertyValue('--term-cell-width')).toBe('')
    expect(container.style.getPropertyValue('--term-cell-delta')).toBe('')
    expect(measure).not.toHaveBeenCalled()
  })

  it('publishes nothing for NaN/Infinity cell widths', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    expect(publishCellMetric(container, Number.NaN, () => 8.4)).toBeNull()
    expect(publishCellMetric(container, Number.POSITIVE_INFINITY, () => 8.4)).toBeNull()
    expect(container.style.getPropertyValue('--term-cell-width')).toBe('')
  })

  it('publishes nothing when the natural advance is unmeasurable (0)', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    expect(publishCellMetric(container, 8.5, () => 0)).toBeNull()
    expect(container.style.getPropertyValue('--term-cell-width')).toBe('')
    expect(container.style.getPropertyValue('--term-cell-delta')).toBe('')
  })
})
