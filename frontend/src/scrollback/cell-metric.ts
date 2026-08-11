// Frozen output must be laid out on the terminal's cell metric (nocx-yy9g).
//
// xterm rasterises its grid into a GPU atlas at a cell advance SNAPPED TO
// WHOLE DEVICE PIXELS (renderers/font.ts); the DOM lays the same characters
// out at the font's natural fractional advance. Both surfaces resolve the
// same font chain (FONT_FAMILY ≡ --font-family-mono, verified by test), so
// this is not font substitution — the two agree on the font and disagree on
// the metric. A fraction of a pixel per cell, over a hundred columns, is
// several columns of drift: a block that fitted the pane while live grows a
// horizontal scrollbar once frozen (the block was wider in the measured
// screenshots; with a different platform font it can equally come out
// narrower — both are the same defect, a pitch no one chose).
//
// The DOM cannot simply be trusted to match, and the reason must stay in
// sight or the next person deletes the correction as redundant: CSS has no
// term for "xterm's ceiled cell width". `cell-width / N` is not a number a
// stylesheet can compute from the font, because the snap depends on the
// device pixel ratio at rasterise time. So the measurement the renderer
// already owns (_getCellDims → cellWidth, the same source FitAddon uses) is
// published here as custom properties the block lays out on:
//
//   --term-cell-width  the cell width the frozen block must reproduce
//   --term-cell-delta  cellWidth − naturalAdvance, applied as letter-spacing
//
// The correction is per character, so a line of N columns advances exactly
// N × cellWidth (letter-spacing adds to every glyph's advance, wide glyphs
// included; a two-column glyph still advances at the FALLBACK font's own
// metric plus delta — see the report for the measured answer on that).
//
// Refresh: the properties are republished whenever the renderer reports its
// cell dims MAY have changed (mount after fonts load, grid resize, device
// pixel ratio change — xterm re-measures the char size on all three). Old
// blocks ADOPT the current geometry: the properties live on the scrollback
// container and inherit into every block, so a block frozen an hour ago at a
// different pane width re-pitches to today's cell width the moment anything
// republishes. That is deliberate — a frozen block is text in the current
// pane, and keeping its original pitch would re-create the very mismatch
// (block wider than pane) this correction exists to remove, frozen in time.
// The cost is named: a box drawn at 40 columns stays 40 columns, but its
// pixel width follows the pane, exactly like the live grid it came from.

/** The published metric: the renderer's cell width, the DOM's own natural
 *  advance for the same font, and the per-character correction between them. */
export interface CellMetric {
  cellWidth: number
  naturalAdvance: number
  /** cellWidth − naturalAdvance. May be negative: with a platform font whose
   *  natural advance exceeds xterm's snapped cell, the DOM runs WIDER than
   *  the grid — the correction shrinks it back to the grid either way. */
  delta: number
}

const PROBE_CLASS = 'cell-metric-probe'
/** A long run of the widest mono glyph — 64 'W's gives a 0.02 px resolution
 *  on a 1 px layout grid, far finer than the delta we correct. */
const PROBE_CHARS = 64

/** The DOM's own natural per-character advance, measured from a hidden probe
 *  span that inherits the block's font (--font-family-mono, --font-size-
 *  terminal) by living inside the scrollback container. 0 when the probe
 *  cannot be measured (jsdom has no layout) — the caller publishes nothing. */
export function measureNaturalAdvance(container: HTMLElement): number {
  const probe = ensureProbe(container)
  const rect = probe.getBoundingClientRect()
  const len = probe.textContent?.length ?? 0
  if (rect.width <= 0 || len === 0) return 0
  return rect.width / len
}

function ensureProbe(container: HTMLElement): HTMLElement {
  const existing = container.querySelector<HTMLElement>(`.${PROBE_CLASS}`)
  if (existing) return existing
  const probe = document.createElement('span')
  probe.className = PROBE_CLASS
  probe.textContent = 'W'.repeat(PROBE_CHARS)
  container.appendChild(probe)
  return probe
}

/** Publish the renderer's cell width onto the container as the custom
 *  properties the frozen block layout consumes. Returns the metric, or null
 *  when either half of the measurement is unavailable — nothing is published
 *  then, and the block falls back to the font's natural advance (the
 *  pre-correction behaviour, no worse than today).
 *
 *  `measureAdvance` is injectable for tests: jsdom computes no layout, so a
 *  test supplies the probe measurement the browser would. */
export function publishCellMetric(
  container: HTMLElement,
  cellWidth: number,
  measureAdvance: (container: HTMLElement) => number = measureNaturalAdvance,
): CellMetric | null {
  if (!Number.isFinite(cellWidth) || cellWidth <= 0) return null
  const natural = measureAdvance(container)
  if (!Number.isFinite(natural) || natural <= 0) return null
  const metric: CellMetric = {
    cellWidth,
    naturalAdvance: natural,
    // 8.5 − 8.4 is 0.09999999999999964 in floats; a delta is a correction
    // in millipixels, so 4 decimals is far finer than any layout grid and
    // keeps the published CSS value (and the tests) honest.
    delta: Math.round((cellWidth - natural) * 1e4) / 1e4,
  }
  container.style.setProperty('--term-cell-width', `${metric.cellWidth}px`)
  container.style.setProperty('--term-cell-delta', `${metric.delta}px`)
  return metric
}
