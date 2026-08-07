/**
 * e2e: Connections page inside Settings.
 *
 * Walks from Settings gear → Connections rail nav → profile CRUD → Save →
 * Connect → verify new SSH tab. Requires the composition-root `onConnect`
 * wire (coordinator-applied line in main.tsx near SURFACE_ID_SETTINGS
 * registration). Without it the Connect button dispatches a no-op and the
 * tab assertion fails.
 */
import { test, expect } from './harness'

test.describe('Connections inside Settings', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('walks from Settings gear to a created SSH tab', async ({ page }) => {
    await page.goto('/')
    // Wait for the app to load.
    await expect(page.locator('.nocx-tab-title').first()).not.toHaveText('', { timeout: 10_000 })

    // Open Settings via keyboard shortcut (Meta+,).
    await page.keyboard.press('Meta+,')
    await expect(page.locator('.ui-page__scroll')).toBeVisible({ timeout: 5000 })

    // Record tab count AFTER Settings is open (Settings is itself a tab).
    const tabsBeforeConnect = await page.locator('.nocx-tab-title').count()

    // Click "Connections" in the left rail.
    await page.locator('.ui-settings-section-nav-item[data-section="Connections"]').click()
    // The view is identified by its own root and its toolbar action, not by a
    // heading: inside Settings no section draws a title of its own — the rail
    // names the section, and the standalone surface's .cm-header > h1 went with
    // the migration to a kit Toolbar (nocx-pp3y.1).
    await expect(page.locator('.cm-root')).toBeVisible({ timeout: 5000 })
    await expect(
      page.locator('[role="toolbar"]').getByRole('button', { name: '+ New connection' }),
    ).toBeVisible()

    // Click "+ New connection". The form buttons are kit Buttons, which own their
    // own class and refuse one from a caller — so they are addressed by their
    // accessible name, which is what the user reads anyway (nocx-pp3y.1).
    await page.locator('[role="toolbar"]').getByRole('button', { name: '+ New connection' }).click()

    // Creation starts from one field: the button opens the New Connection
    // dialog, and the form appears only once quick-connect has parsed what was
    // typed into it ("Parsed fields will be filled into the form", the dialog's
    // own hint). Walking that route rather than waiting for a form the button
    // stopped opening (nocx-z9s9.4).
    const quickConnect = page.getByRole('dialog').filter({ hasText: 'New Connection' })
    await expect(quickConnect).toBeVisible()
    await page.locator('#quick-connect-input').fill('localhost')
    await quickConnect.getByRole('button', { name: 'Next', exact: true }).click()

    await expect(page.locator('.cm-form')).toBeAttached()

    // Fill in the profile form (Name, Host, User).
    //
    // User is required whenever no secret is selected (nocx-74cn added the
    // rule; nocx-vjhz is this spec catching up). Leaving it empty does not fail
    // here — it fails 20 lines down, where Create is refused, no profile is
    // written and the tab count that Connect was supposed to change reads one
    // short. The only visible evidence was a "User is required" toast that
    // nothing asserted on.
    const inputs = page.locator('.cm-form input')
    await inputs.nth(0).fill('Test SSH')
    await inputs.nth(1).fill('localhost')

    // User lives in the form's Authentication tab, and the kit Tabs renders
    // only the active panel — so a user reaches that field by choosing the tab,
    // and so does this test (nocx-z9s9.4).
    await page.locator('.cm-form').getByRole('tab', { name: 'Authentication' }).click()
    await page.locator('#profile-auth-user').fill('tester')

    // The editor is a Dialog and its actions are the dialog's footer — the
    // .cm-form-actions this spec addressed survives only as a CSS rule with no
    // markup behind it, so the locator could never resolve. The primary action
    // is named for what it does to a profile with no id yet.
    const editor = page.getByRole('dialog').filter({ hasText: 'New Connection' })
    await editor.getByRole('button', { name: 'Create Connection', exact: true }).click()

    // Saving closes the dialog (saveProfile → closeDialog), so the form going
    // away IS the save landing — the old "the form opens again after save" was
    // describing a surface that no longer exists.
    await expect(page.locator('.cm-form')).toHaveCount(0, { timeout: 5000 })

    // Connect from the row, which is where a user connects from — the form has
    // no Connect action. Same control connection-password.spec.ts drives.
    await page.locator('[aria-label="Connect to Test SSH"]').click()

    // A new SSH tab should have been created. Asserted with a retrying
    // expectation, not a bare count(): opening the tab is a round trip, so a
    // count read on the next line races it and answers for the DOM as it was.
    await expect(page.locator('.nocx-tab-title')).toHaveCount(tabsBeforeConnect + 1, {
      timeout: 10_000,
    })

    // Verify the new tab is not called "Settings".
    const newTab = page.locator('.nocx-tab-title').last()
    await expect(newTab).not.toHaveText('Settings')
  })
})
