import { test, expect } from './harness'

const CARET = '[aria-label="Quick connect"]'
const QUICK_CONNECT_ITEM = '.quick-connect__item'
const QUICK_CONNECT_SEARCH = '.quick-connect__search input'

test.describe('quick-connect picker', () => {
  test('the caret lists "New connection" — the one command admitted to the server list', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    // Click the caret beside +.
    await page.locator(CARET).click()

    // The caret's presentation is the plain server list, with exactly one
    // command admitted to it: "New connection" (nocx-d4us). Creating a
    // connection is still connecting to a machine — one not saved yet — so
    // on the disposable dev stand (no profiles, no aliases) the list holds
    // that one row and nothing else. The old "No matches" assertion is gone
    // from this case: an empty query always matches the admitted row. (The
    // empty notice still exists — a malformed query like "user@" renders a
    // parse-failure message there — it is just unreachable on open.)
    await expect(page.locator(QUICK_CONNECT_SEARCH)).toBeVisible()
    await expect(page.locator(QUICK_CONNECT_ITEM)).toHaveCount(1)
    await expect(page.locator(QUICK_CONNECT_ITEM)).toContainText('New connection')

    // The guard that must survive: admitting kind === 'command' wholesale
    // would put every command in front of the caret. Forwarding a port and
    // opening a local shell are different jobs from connecting to a machine,
    // so neither row may appear here.
    await expect(page.locator(QUICK_CONNECT_ITEM)).not.toContainText('Forward a port')
    await expect(page.locator(QUICK_CONNECT_ITEM)).not.toContainText('Local shell')
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

    // Focus returns to WHERE IT WAS, which is the prompt — not to the caret.
    // The overlay stack restores prevFocus, and prevFocus is whatever was
    // active when the picker opened: clicking the caret does not take focus
    // off the editor, so escaping a picker you did not want puts the cursor
    // back where you were typing. Asserting the caret was asserting the
    // mechanism's input rather than its result, and it was wrong about the
    // input (nocx-z9s9.9).
    await expect(page.locator('.pane.active .nocx-editor-input')).toBeFocused()
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
