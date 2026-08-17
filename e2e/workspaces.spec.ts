import { test, expect, promptReady, type Page } from './harness'

/**
 * e2e: THE EPIC'S HEADLINE (nocx-isoph, and nocx-isoph.5's first four
 * criteria).
 *
 * A person creates a workspace and it is minted together with its first tab.
 * They open tabs in it and in the default workspace, and THE DEFAULT ONE
 * NEVER SHOWS A HEADER, A NAME OR A COLOUR — the chip over it is a glyph with
 * no label, before another workspace exists and after. They switch between
 * the two and the strip shows one at a time. They close the workspace; the
 * dialog names what is live before anything dies, and the window is back in
 * the default with the tab it left there.
 *
 * The whole thing runs against the real backend over the real socket: every
 * workspace, tab and pane here is a row in the content store, and the strip
 * is drawn from what `layout.read` answers.
 *
 * What is deliberately NOT asserted: the fence. There is none — this epic
 * ships membership (workspaces-ux §5.5), and the assertion that no surface
 * claims otherwise is a unit test over the shipped strings
 * (frontend/src/workspace-vocabulary.test.ts), because a claim that is not on
 * screen today is exactly the one a spec would stop noticing.
 */

const TAB = '.nocx-tab'
const CHIP = '.nocx-workspace-chip .ui-button'
const MENU_ITEM = '.ui-context-menu__item'
const HEADING = '.tabstrip-group-heading'
/** The dialog that is UP. A closed `<dialog>` keeps its panel in the DOM —
 *  the quick-connect palette is one — so a bare `.nocx-dialog__panel` matches
 *  two elements and Playwright's strict mode is right to refuse it. */
const DIALOG = 'dialog[open] .nocx-dialog__panel'

/** The switcher, open. */
async function openSwitcher(page: Page): Promise<void> {
  await page.locator(CHIP).click()
  await expect(page.locator(MENU_ITEM).first()).toBeVisible({ timeout: 10_000 })
}

async function pickSwitcherItem(page: Page, label: string): Promise<void> {
  await openSwitcher(page)
  await page.locator(MENU_ITEM, { hasText: label }).first().click()
  await expect(page.locator(MENU_ITEM)).toHaveCount(0, { timeout: 10_000 })
}

/** The ids of the tabs the window is showing, in order. */
function shownTabIds(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.nocx-tab')).map((t) => t.getAttribute('data-pane-id')),
  )
}

test.describe('a workspace is a group of tabs, and the window shows one at a time', () => {
  test('created with its first tab, switched between, and closed — while the default never renders', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator(TAB)).toHaveCount(1, { timeout: 15_000 })
    await promptReady(page)

    // ── The default workspace, alone: no header, no name, no colour ──────
    const chip = page.locator(CHIP)
    await expect(chip).toBeVisible()
    await expect(chip).toHaveText('')
    await expect(page.locator(HEADING)).toHaveCount(0)
    await expect(page.locator(`${TAB}[data-colour]`)).toHaveCount(0)
    const [inDefault] = await shownTabIds(page)
    expect(inDefault).not.toBeNull()

    // ── New workspace: created with its first tab ────────────────────────
    await pickSwitcherItem(page, 'New workspace')
    const name = page.locator(`${DIALOG} .ui-text-field__input`)
    await expect(name).toBeVisible({ timeout: 10_000 })
    await name.fill('e2e-refactor-auth')
    await page.locator(`${DIALOG} button`, { hasText: 'Save' }).click()

    // The window follows the workspace it just made: one tab, and it is not
    // the one the default holds.
    await expect(page.locator(TAB)).toHaveCount(1, { timeout: 15_000 })
    await promptReady(page)
    await expect(chip).toHaveText('e2e-refactor-auth')
    const [inWorkspace] = await shownTabIds(page)
    expect(inWorkspace).not.toBe(inDefault)

    // ── Back to the default: the chip loses its label again ──────────────
    // "Not a counter": another workspace exists now, and the default's chrome
    // is exactly what it was — no header anywhere, no name on the chip.
    await pickSwitcherItem(page, 'Ungrouped tabs')
    await expect(chip).toHaveText('', { timeout: 15_000 })
    await expect(page.locator(HEADING)).toHaveCount(0)
    expect(await shownTabIds(page)).toEqual([inDefault])

    // ── And back into the workspace, which is still there ────────────────
    await pickSwitcherItem(page, 'e2e-refactor-auth')
    await expect(chip).toHaveText('e2e-refactor-auth', { timeout: 15_000 })
    expect(await shownTabIds(page)).toEqual([inWorkspace])

    // ── Closing it asks first, and names what it takes ───────────────────
    await pickSwitcherItem(page, 'Close workspace')
    const dialog = page.locator(DIALOG)
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog).toContainText('e2e-refactor-auth')
    await expect(dialog).toContainText('1 tab')
    await dialog.locator('button', { hasText: 'Close workspace' }).click()

    // The window is back where a window with no workspace of its own is: the
    // default, holding the tab it left there.
    await expect(chip).toHaveText('', { timeout: 15_000 })
    await expect
      .poll(() => shownTabIds(page), {
        timeout: 15_000,
        message: 'the window never came back to the default workspace',
      })
      .toEqual([inDefault])
    // And the workspace is gone from the switcher — nothing to switch to.
    await openSwitcher(page)
    await expect(page.locator(MENU_ITEM, { hasText: 'e2e-refactor-auth' })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })
})
