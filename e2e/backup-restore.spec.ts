import { test, expect } from './harness'

/**
 * The backup surface must be usable through the real renderer and control plane,
 * not only through unit fixtures. The empty disposable profile is intentional:
 * it proves the complete create/save/read/preview/restore protocol without
 * coupling this acceptance check to another settings editor.
 */
test.describe('Backup & Restore', () => {
  test('creates, reads, previews and restores a backup', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab-title').first()).not.toHaveText('', { timeout: 10_000 })

    await page.keyboard.press('Meta+,')
    await expect(page.locator('.ui-page__scroll')).toBeVisible({ timeout: 5000 })
    await page
      .locator('.ui-settings-section-nav-item[data-section="Backup & Restore"] button')
      .click()
    await expect(page.getByRole('heading', { name: 'Create backup' })).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Create backup', exact: true }).click()
    const download = await downloadPromise
    const backupPath = await download.path()
    expect(backupPath).not.toBeNull()

    await page.locator('.ui-file-input__native').setInputFiles(backupPath!)
    await expect(page.getByRole('heading', { name: /Preview — merge/ })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByRole('button', { name: 'Merge backup', exact: true })).toBeEnabled()

    await page.getByRole('button', { name: 'Merge backup', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Merge', exact: true }).click()
    await expect(page.getByText('Restore complete (merge).')).toBeVisible({ timeout: 10_000 })
  })
})
