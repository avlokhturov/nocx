import { test, expect } from './harness'

test.describe('theme switching', () => {
  const THEME_ROW = '.ui-settings-row[data-key="ui.theme"]'
  const THEME_SELECT = `${THEME_ROW} select`

  test('switches theme via settings with no terminal remount', async ({ page }) => {
    // Open the app and wait for the initial terminal tab
    await page.goto('/')
    await expect(page.locator('.nocx-tab-title').first()).not.toHaveText('', { timeout: 10_000 })

    // Count panes before theme change
    const initialPaneCount = await page.locator('.pane').count()

    // Open Settings and find the theme select. `ui.theme` lives in the
    // Interface section (internal/settings/settings.go), and Settings opens on
    // its FIRST section — so the row is in the DOM and hidden until the rail
    // navigates to it.
    await page.keyboard.press('Meta+,')
    await page.locator('.ui-settings-section-nav-item[data-section="Interface"] button').click()
    await expect(page.locator(THEME_SELECT)).toBeVisible({ timeout: 5000 })

    // Switch to light theme and wait for the async round-trip:
    // selectOption → RPC set → backend → notifier → observer refetch →
    // reconcileThemeFromGo → data-theme attribute
    await page.selectOption(THEME_SELECT, 'light')
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'light',
      { timeout: 5000 },
    )

    // Close Settings
    await page.keyboard.press('Meta+w')
    await expect(page.locator('.nocx-tab-title').first()).not.toHaveText('', { timeout: 5000 })

    // Verify no terminal panes were created or destroyed (no remount)
    await expect(page.locator('.pane')).toHaveCount(initialPaneCount, { timeout: 5000 })

    // Switch back to tokyo-night
    await page.keyboard.press('Meta+,')
    await page.locator('.ui-settings-section-nav-item[data-section="Interface"] button').click()
    await expect(page.locator(THEME_SELECT)).toBeVisible({ timeout: 5000 })
    await page.selectOption(THEME_SELECT, 'tokyo-night')
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'tokyo-night',
      { timeout: 5000 },
    )

    // Close Settings
    await page.keyboard.press('Meta+w')
    await expect(page.locator('.nocx-tab-title').first()).not.toHaveText('', { timeout: 5000 })

    // Still no pane churn after switching back
    await expect(page.locator('.pane')).toHaveCount(initialPaneCount, { timeout: 5000 })
  })
})
