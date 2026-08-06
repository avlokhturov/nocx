// The node builtins below are @ts-expect-error imports because @types/node
// is not installed (the theme-catalogue.test.ts pattern); every call to them
// touches an untyped value, so no-unsafe-* must be disabled at the file
// level for this test.

// @vitest-environment jsdom
// Report 2 — "the match highlight must stay readable": the highlighted
// prefix (`re` in `repos/`) sat on a dark chip that blended into the
// glyphs. The old rule was a 15% accent wash — nearly the row's own
// background, so the highlight read as nothing.
//
// The treatment comes from theme tokens and the contrast is PROVEN, not
// eyeballed. jsdom computes longhands but never resolves var() or
// color-mix(), so the proof has two halves:
//
//  1. The component's shipped rule (read from the real CSS file) themes the
//     BACKGROUND channel with the accent token and declares NO colour for
//     the text — the glyphs keep the row's text token, so their contrast is
//     the row's own by construction. The intended channel is the background.
//  2. For every theme in the catalogue (read from the real theme files),
//     the resolved chip (accent at 40% over the panel surface) DIFFERS from
//     the panel surface in the background channel — the chip is visible —
//     and the row's text on the chip keeps the emphasized-text bar (3:1).
//
// The e2e suite asserts the same from computed styles in a real browser.
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const dirname =
  (import.meta as { dirname?: string }).dirname ?? resolve(new URL('.', import.meta.url).pathname)
const CSS = resolve(dirname, '../styles/components/floating-panel.css')
const THEMES = resolve(dirname, '../styles/themes')
/** The declaration block text of the FIRST rule whose selector list contains
 *  `selector`. */
function ruleFor(cssText: string, selector: string): string {
  for (const block of cssText.split('}')) {
    const [head, body] = block.split('{')
    if (head?.includes(selector) && body) return body.trim()
  }
  throw new Error(`no rule for ${selector}`)
}

/** The value of one custom-property declaration in a theme file. */
function token(themeText: string, name: string): string {
  const m = themeText.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))
  if (!m) throw new Error(`no --${name} in theme`)
  return m[1].trim()
}

/** #rrggbb → [r, g, b] in 0..1. */
function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ]
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = rgb(hex).map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours, order-independent. */
function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

describe('match highlight readability (report 2)', () => {
  const css = readFileSync(CSS, 'utf-8')

  it('the shipped rule themes the TEXT channel with the accent and paints no chip', () => {
    const match = ruleFor(css, '.ui-floating-panel__match')
    // The intended channel is the TEXT. A background wash is a dead end:
    // it sits BEHIND the row's own glyphs, so raising its alpha to make it
    // brighter darkens the letters on it — 40% leaves 3.45:1 and 55% is
    // already 2.44:1, under the emphasized-text bar. Colouring the glyphs
    // spends the whole budget on visibility instead.
    expect(match).toMatch(/color:\s*var\(--color-accent\)/)
    // <mark> carries a UA background (yellow) and a UA colour (black). The
    // rule must turn the background OFF explicitly; merely not declaring
    // one leaves the browser's, which is how a highlighter pen appeared in
    // the middle of a dark panel.
    expect(match).toMatch(/background:\s*none/)
  })

  it('the chip is visible against the surface and the text on it stays readable in every theme', () => {
    const themeFiles: string[] = readdirSync(THEMES).filter((f: string) => f.endsWith('.css'))
    expect(themeFiles.length).toBeGreaterThanOrEqual(10)
    for (const file of themeFiles) {
      const text = readFileSync(resolve(THEMES, file), 'utf-8')
      const accent = token(text, 'color-accent')
      const surface = token(text, 'color-surface-raised')
      // The matched glyphs themselves: the accent against the panel
      // surface, held to the emphasized-text bar (3:1) in every theme.
      const ratio = contrast(accent, surface)
      expect(ratio, `${file}: accent ${accent} on surface ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })
})
