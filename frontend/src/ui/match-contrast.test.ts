// The node builtins below are @ts-expect-error imports because @types/node
// is not installed (the theme-catalogue.test.ts pattern); every call to them
// touches an untyped value, so no-unsafe-* must be disabled at the file
// level for this test.
/* eslint-disable @typescript-eslint/no-unsafe-assignment,
                      @typescript-eslint/no-unsafe-call,
                      @typescript-eslint/no-unsafe-member-access,
                      @typescript-eslint/no-unsafe-argument */
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
// @ts-expect-error @types/node is not installed (see theme-catalogue.test.ts)
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error @types/node is not installed (see theme-catalogue.test.ts)
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

/** The chip the browser paints: the accent at the wash's alpha over the
 *  panel surface (the rule mixes with transparent, so it composites over
 *  the panel's own background). */
function chip(accent: string, surface: string, alpha: number): string {
  const [ar, ag, ab] = rgb(accent)
  const [sr, sg, sb] = rgb(surface)
  const mix = (a: number, s: number) => Math.round((a * alpha + s * (1 - alpha)) * 255)
  const toHex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${toHex(mix(ar, sr))}${toHex(mix(ag, sg))}${toHex(mix(ab, sb))}`
}

describe('match highlight readability (report 2)', () => {
  const css = readFileSync(CSS, 'utf-8')

  it('the shipped rule themes the background channel with the accent and leaves the text alone', () => {
    const match = ruleFor(css, '.ui-floating-panel__match')
    // The intended channel is the BACKGROUND: the highlight is a chip, and
    // the chip must not blend into the row (the owner's "a dark chip that
    // blends into the glyphs" — the old 15% wash read as the row itself).
    expect(match).toContain('background:')
    expect(match).toContain('var(--color-accent)')
    // No colour rule: the glyphs keep the row's text token, so their
    // contrast is the row's own — untouched by the chip.
    expect(match).not.toMatch(/color:/)
  })

  it('the chip is visible against the surface and the text on it stays readable in every theme', () => {
    const themeFiles: string[] = readdirSync(THEMES).filter((f: string) => f.endsWith('.css'))
    expect(themeFiles.length).toBeGreaterThanOrEqual(10)
    for (const file of themeFiles) {
      const text = readFileSync(resolve(THEMES, file), 'utf-8')
      const accent = token(text, 'color-accent')
      const surface = token(text, 'color-surface-raised')
      const rowText = token(text, 'color-text')
      // The intended channel is the BACKGROUND: the chip must not blend
      // into the row it sits on. Resolved, the 40% wash differs from the
      // panel surface in every theme (the old 15% wash did not).
      const chipColor = chip(accent, surface, 0.4)
      expect(chipColor, `${file}: chip ${chipColor} vs surface ${surface}`).not.toBe(surface)
      // And the glyphs on the chip stay readable. The text is the row's own
      // token (untouched by the chip), so the floor is the emphasized-text
      // bar: 3:1. A 2-char emphasis at 600 weight on a visible wash is the
      // report's fix — the failure was a chip that READ AS the row.
      const ratio = contrast(rowText, chipColor)
      expect(ratio, `${file}: text ${rowText} on chip ${chipColor}`).toBeGreaterThanOrEqual(3)
    }
  })
})
