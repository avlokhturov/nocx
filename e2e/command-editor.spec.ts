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

/**
 * Where a word of the command line actually is, in page coordinates.
 *
 * The editor's content is text inside a contenteditable, so a word is not an
 * element and no locator can name one. A Range can: walk the text nodes CM6
 * rendered, map the word's offset into whichever node holds it, and measure it.
 * That is the anchor — the coordinate is derived from it rather than assumed.
 *
 * CM6 splits a line across several text nodes when it decorates the syntax, so
 * this walks nodes and accumulates rather than reading `textContent` once.
 */
async function wordCenter(
  page: import('@playwright/test').Page,
  word: string,
): Promise<{ x: number; y: number }> {
  const rect = await page.evaluate((needle) => {
    const input = document.querySelector('.nocx-editor-input')
    if (input === null) throw new Error('editor input not in the document')

    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT)
    let consumed = 0
    const start = (input.textContent ?? '').indexOf(needle)
    if (start < 0) throw new Error(`the editor does not contain ${needle}`)

    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const len = node.textContent?.length ?? 0
      // The word has to sit inside ONE text node for a Range to measure it;
      // a word split across two would mean CM6 decorated part of it, and
      // silently measuring the fragment is how a fragile test comes back.
      if (start >= consumed && start + needle.length <= consumed + len) {
        const range = document.createRange()
        range.setStart(node, start - consumed)
        range.setEnd(node, start - consumed + needle.length)
        const r = range.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      consumed += len
    }
    throw new Error(`${needle} spans more than one text node — cannot measure it`)
  }, word)

  if (rect.width === 0 || rect.height === 0) {
    throw new Error(`${word} measured zero — the editor is not laid out yet`)
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
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

    // Aim at the word, not at a number.
    //
    // This used to double-click `box.x + 120` and accept any of the four words
    // back. 120px from the left edge is a claim about the terminal FONT: on the
    // author's Mac it lands inside `world`, and in the e2e container it lands on
    // the space before it, so the selection came back as " " and the test failed
    // on a product that was working (nocx-z9s9.10).
    //
    // A double-click is inherently positional — a user does put the pointer
    // somewhere — so the coordinate stays. What changes is where it comes from:
    // a Range over the word itself, measured in the page at run time. Whatever
    // the font, the point is inside `world`, and the assertion can then be the
    // one the product actually owes — that word and no other.
    const target = await wordCenter(page, 'world')
    await page.mouse.dblclick(target.x, target.y)

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
    // And it is exactly the word that was clicked — never a partial range, a
    // neighbouring word, or the whitespace between two.
    expect(sel.text).toBe('world')
  })

  /**
   * The DONE WHEN of the CM6 epic (nocx-2gf): shell token highlighting is
   * visible in the running app.
   *
   * `editor.test.ts` already asserts what the grammar produces, thoroughly and
   * in jsdom — which is where the gap was. jsdom loads no stylesheet, so a
   * token class there proves the tokenizer ran and says nothing about whether
   * anything is painted: a build that dropped style.css, or renamed the
   * classes on one side only, keeps every one of those tests green while the
   * user looks at one flat colour.
   *
   * So this asserts the two halves that only a real browser can: the classes
   * appear on the live line, and the roles are painted APART. Distinctness is
   * the honest form of "visible" — comparing against a hard-coded hex would
   * assert the current theme (there are several, and they are user-chosen),
   * while a role that shares its neighbour's colour is exactly the failure a
   * person would report.
   */
  test('shell tokens are classed and painted apart in the running app', async ({ page }) => {
    await waitForPrompt(page)
    await expect(page.locator(EDITOR)).toBeVisible({ timeout: 8000 })
    await page.locator(INPUT).fill('ls -la | grep foo')

    const roles = await page.evaluate(() => {
      const input = document.querySelector('.nocx-editor-input')
      if (input === null) throw new Error('editor input not in the document')
      const seen: Record<string, { text: string; color: string }> = {}
      for (const span of input.querySelectorAll<HTMLElement>('[class*="tok-"]')) {
        for (const cls of span.className.split(/\s+/)) {
          if (cls.startsWith('tok-') && !(cls in seen)) {
            seen[cls] = { text: span.textContent ?? '', color: getComputedStyle(span).color }
          }
        }
      }
      return seen
    })

    // The grammar is running against the live line, not only in a unit test.
    expect(roles['tok-flag']?.text).toBe('-la')
    expect(roles['tok-operator']?.text).toBe('|')

    // And the roles do not share a colour. `tok-command` is deliberately left
    // out of the comparison: a command word the session cannot resolve gives
    // up the command colour by design (.tok-command.tok-unresolved in
    // style.css), so its paint depends on what the shell reported, which is
    // not what this test is about.
    expect(roles['tok-flag']?.color).not.toBe(roles['tok-operator']?.color)
    expect(roles['tok-path']?.color).not.toBe(roles['tok-operator']?.color)
  })
})
