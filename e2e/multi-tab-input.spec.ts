import { test, expect, promptReady, clickIntoEditor } from './harness'

// nocx-4ff.28: opening a second tab leaves the first unable to accept
// keyboard input. The user-observable contract is that every tab accepts
// keystrokes when it is active, regardless of how many other tabs exist.

const TITLE = '.nocx-tab-title'
const TAB = '.nocx-tab'
const TAB_ADD = '[aria-label="New tab"]'

test.describe('multi-tab input (nocx-4ff.28)', () => {
  test('first tab still accepts input after second tab is created', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator(TAB)).toHaveCount(1)
    await promptReady(page)

    // Record tab 1's current title so we can assert it changes.
    const tab1InitialTitle = await page.locator(TITLE).first().textContent()

    // Create a second tab.
    await page.locator(TAB_ADD).click()
    await expect(page.locator(TAB)).toHaveCount(2)

    // Wait for tab 2's prompt to be ready.
    await promptReady(page)

    // Switch back to tab 1 by clicking its tab button.
    await page.locator(TAB).first().click()

    // Click into the editor of tab 1 to give it focus.
    // Post tab-switch the editor may not auto-focus (nocx-4ff.29); this
    // test must isolate nocx-4ff.28 (typing in an active tab with focus
    // in its editor), so we manually place focus first.
    await clickIntoEditor(page)
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className ?? ''), { timeout: 5000 })
      .toContain('nocx-editor-input')

    // Now type a command that sets the OSC 0 title.
    // If Tab 2's _globalKeydown steals focus, the keystroke lands in tab 2's
    // editor and tab 1's title never changes.
    const marker = `T1-${Date.now().toString(36)}`
    await page.keyboard.type(`printf '\\033]0;${marker}\\007'`)
    await page.keyboard.press('Enter')

    // Tab 1's title must reflect the keystroke.
    await expect(page.locator(TITLE).first()).toHaveText(marker, { timeout: 5000 })

    // Tab 2 must NOT have received the keystroke.
    //
    // Stated as "tab 2 never shows the marker", not as "tab 2's title equals
    // the string we captured earlier". The captured form asserted something
    // the product never promised: a fresh tab's title starts as `~` and
    // becomes its real cwd when the shell's OSC 7 arrives, which is AFTER
    // promptReady — the editor is focused before the shell has reported where
    // it is. So the snapshot caught `~` mid-transition and the assertion
    // failed on `.e2e/home`, a change the tab made by itself with no keystroke
    // involved.
    //
    // That window is a function of machine speed, which is exactly why this
    // was a CI-only failure: with cores to spare the OSC 7 lands before the
    // capture and the strings match. Capped at the runner's 4 vCPU it lands
    // after, and the same tree fails. The defect was in the assertion, not in
    // the product and not in the runner.
    //
    // Ordering is what makes this safe rather than vacuous: tab 1's title has
    // already become the marker above, so the keystroke is known to have been
    // routed and rendered by the time this runs. A `not` assertion here is
    // therefore a real check, not one that passes because nothing has
    // happened yet.
    await expect(page.locator(TITLE).nth(1)).not.toHaveText(marker)

    // And tab 1's title is definitely different from initial.
    //
    // This was missing its await, which is why nocx-ifgp looked load-dependent:
    // an unawaited web-first assertion returns a promise nobody holds, so it
    // never runs at the point it is written and its eventual rejection surfaces
    // somewhere else — or not at all. It asserted nothing on a good day and
    // failed the run on a bad one.
    await expect(page.locator(TITLE).first()).not.toHaveText(tab1InitialTitle!, {
      timeout: 5000,
    })
  })

  test('second tab accepts input while it is active', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator(TAB)).toHaveCount(1)
    await promptReady(page)

    // Create a second tab.
    await page.locator(TAB_ADD).click()
    await expect(page.locator(TAB)).toHaveCount(2)
    await promptReady(page)

    // Tab 2 is now active. Type a command into it.
    const marker = `T2-${Date.now().toString(36)}`
    await page.keyboard.type(`printf '\\033]0;${marker}\\007'`)
    await page.keyboard.press('Enter')

    // Tab 2's title must reflect the keystroke (nth(1) = second tab).
    await expect(page.locator(TITLE).nth(1)).toHaveText(marker, { timeout: 5000 })
  })
})
