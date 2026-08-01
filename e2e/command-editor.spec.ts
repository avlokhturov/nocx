import { test, expect } from './harness' // shared Wails WS-port shim for headless CI

const TITLE = '.nocx-tab-title'
const EDITOR = '.nocx-editor'
const INPUT = '.nocx-editor-input'

async function waitForPrompt(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.locator(TITLE).first()).not.toHaveText('', {
    timeout: 15000,
  })
}

test.describe('command editor (nocx-4ff)', () => {
  // A clean local prompt owns input immediately — the editor must not wait for a
  // command to run first. Regression for the spurious OSC 133 C emitted while
  // nocx.bash was being sourced, which left the first prompt untrusted.
  test('editor is visible at the first prompt', async ({ page }) => {
    await waitForPrompt(page)
    await expect(page.locator(EDITOR)).toBeVisible({ timeout: 8000 })
  })

  // Regression for the WebGL link-layer canvas (z-index:2) that won hit-testing
  // over the editor, so every click, caret move and word-select landed on the
  // terminal canvas.
  //
  // This comment used to say "the editor sits at z-index:20 above every xterm
  // layer". It does not, and never did in this era: .nocx-editor has no z-index
  // at all, and nothing in the project sets 20. What actually keeps the two
  // apart is geometry — the link canvas lives inside .xterm-live-container, a
  // separate flex row with overflow:hidden that is zero pixels tall when idle,
  // so the two never overlap (nocx-0oc, and
  // .internal/reports/2026-08-01-editor-stacking-and-test-surface.md).
  //
  // The test is kept anyway, and asserts the property rather than the mechanism:
  // the point over the input surface belongs to the editor. That stays true if
  // the layout changes again, which a z-index assertion would not.
  test('mouse hit-tests the editor surface, not the terminal canvas', async ({ page }) => {
    await waitForPrompt(page)
    await expect(page.locator(EDITOR)).toBeVisible({ timeout: 8000 })
    await page.locator(INPUT).fill('echo hello world foobar')

    // The input surface is CM6's contenteditable contentDOM now (ADR-0010),
    // not a textarea. What the regression is about is the EDITOR winning the
    // point — the link layer stealing it made the editor unclickable — so
    // assert the hit lands inside .nocx-editor rather than asserting a tag.
    const hitInsideEditor = await page.evaluate(() => {
      const editor = document.querySelector('.nocx-editor') as HTMLElement
      const el = document.querySelector('.nocx-editor-input') as HTMLElement
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return hit !== null && editor.contains(hit)
    })
    expect(hitInsideEditor).toBe(true)
  })

  test('double-click selects a word in the editor', async ({ page }) => {
    await waitForPrompt(page)
    await expect(page.locator(EDITOR)).toBeVisible({ timeout: 8000 })
    await page.locator(INPUT).fill('echo hello world foobar')

    const box = (await page.locator(INPUT).boundingBox())!
    await page.mouse.dblclick(box.x + 120, box.y + box.height / 2)

    // CM6 keeps the native DOM selection in sync with the editor selection,
    // so the picked word is observable via getSelection(). The textarea's
    // selectionStart/selectionEnd have no equivalent on a contenteditable.
    const sel = await page.evaluate(() => {
      const input = document.querySelector('.nocx-editor-input') as HTMLElement
      const s = window.getSelection()
      return {
        text: s?.toString() ?? '',
        insideEditor: s !== null && s.anchorNode !== null && input.contains(s.anchorNode),
      }
    })
    // The selection must live in the editor, not in the terminal behind it.
    expect(sel.insideEditor).toBe(true)
    // And it must be a word — double-click selects exactly one word of the
    // command, never a partial or cross-word range.
    expect(sel.text.length).toBeGreaterThan(0)
    expect(['echo', 'hello', 'world', 'foobar']).toContain(sel.text)
  })
})
