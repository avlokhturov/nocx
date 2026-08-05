import { test, expect } from './harness'

const CARET = '[aria-label="Quick connect"]'
const QUICK_CONNECT_LIST = '.quick-connect__list'
const QUICK_CONNECT_ITEM = '.quick-connect__item'
const QUICK_CONNECT_SEARCH = '.quick-connect__search input'
const QUICK_CONNECT_EMPTY = '.quick-connect__empty'

test.describe('quick-connect picker', () => {
  test('the caret opens the plain server list — hosts only, no commands', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    // Click the caret beside +.
    await page.locator(CARET).click()

    // The picker dialog is open. The caret's presentation is the plain
    // server list: on the disposable dev stand there are no profiles or
    // aliases, so it says so instead of showing commands.
    await expect(page.locator(QUICK_CONNECT_SEARCH)).toBeVisible()
    await expect(page.locator(QUICK_CONNECT_EMPTY)).toContainText('No matches')
    await expect(page.locator(QUICK_CONNECT_ITEM)).toHaveCount(0)
  })

  test('Escape closes the picker and restores focus to the caret', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    // Click the caret to open the picker.
    await page.locator(CARET).click()
    await expect(page.locator(QUICK_CONNECT_SEARCH)).toBeVisible()

    // Press Escape to close.
    await page.keyboard.press('Escape')

    // Picker is closed.
    await expect(page.locator(QUICK_CONNECT_SEARCH)).not.toBeVisible()

    // Focus returns to the caret (Dialog's overlay stack restores focus).
    await expect(page.locator(CARET)).toBeFocused()
  })

  test('the chord opens the palette: commands and hosts mixed, rows typed', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    // Use the keyboard shortcut.
    await page.keyboard.press('Control+Shift+P')

    // The palette lists commands even with no hosts on the stand, and each
    // row carries its type on the right.
    await expect(page.locator(QUICK_CONNECT_ITEM).first()).toContainText('Local shell')
    await expect(page.locator(QUICK_CONNECT_ITEM).first()).toContainText('Command')

    // Close with Escape.
    await page.keyboard.press('Escape')
    await expect(page.locator(QUICK_CONNECT_SEARCH)).not.toBeVisible()
  })

  test('typing filters the palette to one command', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    await page.keyboard.press('Control+Shift+P')
    await expect(page.locator(QUICK_CONNECT_ITEM).first()).toContainText('Local shell')

    await page.locator(QUICK_CONNECT_SEARCH).fill('forward')

    await expect(page.locator(QUICK_CONNECT_ITEM)).toHaveCount(1)
    await expect(page.locator(QUICK_CONNECT_ITEM)).toContainText('Forward a port')
  })

  test('Enter on "Local shell" opens a new tab', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    // The chord opens the palette; "Local shell" is a command there.
    await page.keyboard.press('Control+Shift+P')

    // Wait for the ITEMS, not just the list. The listbox is rendered before its
    // providers have answered, and Enter on an empty list is correctly a no-op —
    // so pressing it as soon as the container appears is a race that only loses
    // when the profile list is long enough to slow the provider down.
    await expect(page.locator(QUICK_CONNECT_ITEM).first()).toContainText('Local shell')

    // "Local shell" is already selected by default. Press Enter.
    await page.keyboard.press('Enter')

    // A new tab opens.
    await expect(page.locator('.nocx-tab')).toHaveCount(2)

    // The picker closes.
    await expect(page.locator(QUICK_CONNECT_SEARCH)).not.toBeVisible()
  })

  test('terminal host element persists through picker open/close', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    // The terminal host element exists.
    const pane = page.locator('.pane.active')
    await expect(pane).toBeVisible()

    // Open the picker.
    await page.locator(CARET).click()
    await expect(page.locator(QUICK_CONNECT_SEARCH)).toBeVisible()

    // The terminal host is still in the DOM.
    await expect(pane).toBeVisible()

    // Close the picker.
    await page.keyboard.press('Escape')
    await expect(page.locator(QUICK_CONNECT_SEARCH)).not.toBeVisible()

    // Terminal host still present.
    await expect(pane).toBeVisible()
  })
})
