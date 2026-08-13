import { test, expect, promptReady } from './harness'

/**
 * nocx-2gf.1 — each keystroke rescue puts EXACTLY ONE character in the prompt.
 *
 * `terminal-content.ts` `_globalKeydown` rescues a printable key that arrives
 * while the editor is up but does not have focus, and it does so along two
 * paths that look inconsistent and are not:
 *
 *   - a block is selected (terminal-content.ts:1427): `preventDefault()`, focus,
 *     then `insertText(e.key)`. The event's target is a frozen block, which is
 *     not an editing host, so there is no native insertion to lean on — the
 *     character has to be placed programmatically.
 *   - focus has drifted to the body (terminal-content.ts:1536): `focus()` only,
 *     deliberately WITHOUT `preventDefault()`. The keydown's target was fixed
 *     when it was dispatched, so CM6 never sees the event; the browser's own
 *     default action runs afterwards against whatever is focused by then, which
 *     is the contentDOM this `focus()` just made active, and it lands the
 *     character once.
 *
 * Why here rather than in jsdom: jsdom performs no native text insertion, so on
 * the drift path it observes zero characters no matter what the product does. A
 * zero there is a property of the harness, and asserting it would write a
 * falsehood into the suite. Only a real browser can say whether the native
 * default action actually landed.
 *
 * Why BOTH cases, and not just the drift one: the naive reconciliation — "make
 * both paths call insertText" — DOUBLES the drift character, because the native
 * insertion still runs alongside the programmatic one. The block assertion is
 * what stops the drift assertion from being "fixed" into a doubling: any change
 * that unifies the two paths has to keep both of these at exactly one.
 */

const INPUT = '.pane.active .nocx-editor-input'
const BLOCK = '.pane.active .cmd-block'

const activeTag = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.activeElement?.tagName ?? '')

test.describe('the rescued keystroke lands exactly once (nocx-2gf.1)', () => {
  test('focus drifted to the body: one keystroke, one character', async ({ page }) => {
    await page.goto('/')
    await promptReady(page)
    await expect(page.locator(INPUT)).toHaveText('')

    // The body is the point, not merely "somewhere else". The rescue stands
    // down for a text control and for anything the user could have tabbed to
    // (a button, a link, a positive tabindex), so blurring onto a control
    // would exercise the guard rather than the rescue. Blurring the editor
    // leaves focus on the body, which owns no keys at all.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    expect(await activeTag(page)).toBe('BODY')

    await page.keyboard.press('q')

    // Exactly one: `toHaveText` is an equality, so a doubled character fails
    // here rather than passing as "contains q".
    await expect(page.locator(INPUT)).toHaveText('q', { timeout: 5000 })
    await expect(page.locator(INPUT)).toBeFocused()
  })

  test('a block is selected: one keystroke, one character', async ({ page }) => {
    await page.goto('/')
    await promptReady(page)

    // A frozen block to select. The marker is assembled by the shell so the
    // command text itself never contains it, and the block is therefore
    // evidence of output rather than of the echo.
    await page.keyboard.type("printf 'NOCX-ONCE-%s\\n' BLOCK")
    await page.keyboard.press('Enter')
    const block = page.locator(BLOCK, { hasText: 'NOCX-ONCE-BLOCK' }).first()
    await expect(block).toBeVisible({ timeout: 5000 })
    await expect(page.locator(INPUT)).toHaveText('')

    // Click-to-select is the user's gesture for this (blocks.ts
    // `wireBlockSelection`): a click with no drag toggles the selection.
    await block.click()
    await expect(block).toHaveClass(/cmd-block-selected/)

    await page.keyboard.press('z')

    await expect(page.locator(INPUT)).toHaveText('z', { timeout: 5000 })
    await expect(page.locator(INPUT)).toBeFocused()
    // Typing over a selection also releases it — the character is meant for
    // the prompt, so leaving the block selected would leave the next keystroke
    // taking this same path again.
    await expect(block).not.toHaveClass(/cmd-block-selected/)
  })
})
