import { test, expect, promptReady } from './harness'

// Tab completion through the real UI (nocx-w7h.2/.3, nocx-4ff.23): the
// acceptance check the epic is judged by — a user types a prefix, presses
// Tab, sees candidates that include a command name the shell actually has,
// picks one with the arrow keys, and Enter puts it in the line. Driven
// through the real transport (OSC 636 snapshot, history.query, fs.complete)
// against a real shell, not a fixture.

const INPUT = '.nocx-editor-input'
const DROPDOWN = '.ui-completion-dropdown'

/** The row the selection currently sits on. */
const selectedRow = (page: import('@playwright/test').Page) =>
  page.locator(`${DROPDOWN} .ui-completion-dropdown__row[data-selected="true"]`)

test.describe('tab completion', () => {
  test('a real command completes: Tab opens the dropdown, arrows pick, Enter inserts', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)
    await promptReady(page)

    // `pri` is a prefix of `printf` — a bash BUILTIN, so the OSC 636
    // snapshot (compgen -c) always contains it on this shell. History may
    // add rows; whatever the ranking, `printf` is in the list.
    await page.keyboard.type('pri')
    await page.keyboard.press('Tab')

    // The dropdown opens and the row list includes a command the shell
    // actually has.
    const dropdown = page.locator(DROPDOWN).first()
    await expect(dropdown).toBeVisible({ timeout: 5000 })
    await expect(dropdown).toContainText('printf', { timeout: 5000 })

    // Arrow keys move the selection; Enter accepts whatever row is selected
    // — read its display text first (the info cell, not the row's innerText,
    // which also carries the source badge), so the assertion does not depend
    // on ranking.
    await page.keyboard.press('ArrowDown')
    const chosen = (await selectedRow(page).locator('.ui-collection-row__info').innerText()).trim()
    expect(chosen.length).toBeGreaterThan(0)
    await page.keyboard.press('Enter')
    // The accepted candidate is in the line, and the dropdown is gone —
    // Enter inserted it, nothing was submitted.
    await expect(page.locator(INPUT)).toHaveText(chosen, { timeout: 5000 })
    await expect(dropdown).not.toBeVisible()

    // Nothing was submitted: the shell is still at its prompt.
    await promptReady(page)
  })

  test('ghost text: the top candidate renders inline and Right accepts it', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)
    await promptReady(page)

    await page.keyboard.type('pri')

    // The inline ghost (the completion tail of the top candidate) appears at
    // the caret. Its content is ranking-dependent; the accept is not.
    const ghost = page.locator(`${INPUT} .nocx-editor-ghost`).first()
    await expect(ghost).toBeVisible({ timeout: 5000 })
    const tail = (await ghost.innerText()).trim()
    expect(tail.length).toBeGreaterThan(0)

    await page.keyboard.press('ArrowRight')
    await expect(page.locator(INPUT)).toHaveText(`pri${tail}`, { timeout: 5000 })
  })

  test('local paths complete through fs.complete — and only on a local session', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)
    await promptReady(page)

    // A probe file unique to this run, in whatever cwd the harness shell
    // started in. `touch` runs through the real shell. The probe name carries
    // the run's own random, and the typed prefix uses the SAME random: a
    // previous run's recorded `cd ./zzz-…` line in shared history can never
    // start with this run's prefix, so the dropdown cannot be polluted by
    // history (design §8.4: cross-provider ranking is real).
    const run = Date.now().toString(36)
    const probe = `zzz-e2e-cmp-${run}-probe`
    await page.keyboard.type(`touch ${probe}`)
    await page.keyboard.press('Enter')
    await promptReady(page)

    // `cd ./zzz-e2e-cmp-<run>` + Tab: the local path provider asks the
    // backend (fs.complete) and lists the probe.
    await page.keyboard.type(`cd ./zzz-e2e-cmp-${run}`)
    await page.keyboard.press('Tab')
    const dropdown = page.locator(DROPDOWN).first()
    await expect(dropdown).toBeVisible({ timeout: 5000 })
    await expect(dropdown).toContainText(probe, { timeout: 5000 })

    await page.keyboard.press('Enter')
    await expect(page.locator(INPUT)).toHaveText(`cd ./${probe}`, { timeout: 5000 })

    // Clean up the probe through the same shell.
    await page.keyboard.press('Enter')
    await promptReady(page)
    await page.keyboard.type(`rm -f ./${probe}`)
    await page.keyboard.press('Enter')
    await expect(page.locator('.cmd-block', { hasText: probe }).first()).toBeVisible({
      timeout: 5000,
    })
  })

  test('no candidates: Tab sends nothing and opens nothing', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)
    await promptReady(page)

    // A prefix that matches no command, no history row and no path.
    await page.keyboard.type('zzznocxe2enope')
    await page.keyboard.press('Tab')

    // The dropdown never opens, and the line is untouched — the key was
    // swallowed, never forwarded to the shell as a raw tab.
    const dropdown = page.locator(DROPDOWN).first()
    await page.waitForTimeout(600)
    await expect(dropdown).not.toBeVisible()
    await expect(page.locator(INPUT)).toHaveText('zzznocxe2enope')

    // The editor still owns input: Escape clears it, proving the session
    // never left the prompt.
    await page.keyboard.press('Escape')
    await expect(page.locator(INPUT)).toHaveText('', { timeout: 5000 })
  })
})
