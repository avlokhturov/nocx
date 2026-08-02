import { test, expect, promptReady, type Page } from './harness'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Tab completion through the real UI (nocx-w7h.2/.3, nocx-4ff.23, completion
// pass 2): a user types a prefix, presses Tab, sees candidates, cycles with
// Tab, and Enter puts the choice in the line. Driven through the real
// transport (OSC 636 snapshot, history.query, fs.complete) against a real
// shell, not a fixture.
//
// FIXTURE DISCIPLINE (nocx-yqmy): every fixture directory is a mkdtemp THIS
// run owns, and the session `cd`s there. Nothing is ever created in the
// developer's home or the harness home's cwd — an earlier run wrote
// zzz-e2e-cmp-* files into the real $HOME and the owner found them offered
// as completions in his terminal.

const INPUT = '.nocx-editor-input'
const DROPDOWN = '.ui-completion-dropdown'

/** The row the selection currently sits on. */
const selectedRow = (page: Page) =>
  page.locator(`${DROPDOWN} .ui-completion-dropdown__row[data-selected="true"]`)

/** A fixture directory this run owns; the session cds into it. */
const fixtureDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'nocx-e2e-cmp-'))

/** cd the session into a fixture dir and wait for the prompt (OSC 7 brings
 *  the new cwd with it). */
const cdInto = async (page: Page, dir: string) => {
  await page.keyboard.type(`cd ${dir}`)
  await page.keyboard.press('Enter')
  await promptReady(page)
}

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
    const fixture = fixtureDir()
    try {
      await page.goto('/')
      await expect(page.locator('.nocx-tab')).toHaveCount(1)
      await promptReady(page)

      // The probe is a DIRECTORY: `cd` takes directories only (the
      // dirs-only table), so a file would be filtered out of its completion
      // and this test would fail for the wrong reason.
      const run = Date.now().toString(36)
      const probe = `zzz-e2e-cmp-${run}-probe`
      fs.mkdirSync(path.join(fixture, probe))

      await cdInto(page, fixture)

      // `cd ./zzz-e2e-cmp-<run>` + Tab: the local path provider asks the
      // backend (fs.complete) and lists the probe. The typed prefix carries
      // the run's own random, so a previous run's recorded history line can
      // never start with it — no cross-provider pollution.
      await page.keyboard.type(`cd ./${probe}`)
      await page.keyboard.press('Tab')
      const dropdown = page.locator(DROPDOWN).first()
      await expect(dropdown).toBeVisible({ timeout: 5000 })
      await expect(dropdown).toContainText(probe, { timeout: 5000 })

      await page.keyboard.press('Enter')
      // A directory keeps its trailing slash.
      await expect(page.locator(INPUT)).toHaveText(`cd ./${probe}/`, { timeout: 5000 })
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true })
    }
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

  test('acceptance: cd + Tab lists directories with kind and trailing slash, Tab cycles and previews', async ({
    page,
  }) => {
    const fixture = fixtureDir()
    // The owner's exact scenario: a directory containing a file and two
    // subdirectories.
    fs.writeFileSync(path.join(fixture, 'notes.txt'), 'x')
    fs.mkdirSync(path.join(fixture, 'alpha'))
    fs.mkdirSync(path.join(fixture, 'beta'))
    try {
      await page.goto('/')
      await expect(page.locator('.nocx-tab')).toHaveCount(1)
      await promptReady(page)

      await cdInto(page, fixture)

      // `cd ` + Tab — the empty token, the case that used to offer history
      // rows only, every one labelled "history".
      await page.keyboard.type('cd ')
      await page.keyboard.press('Tab')
      const dropdown = page.locator(DROPDOWN).first()
      await expect(dropdown).toBeVisible({ timeout: 5000 })

      // The two directories, each marked Directory with a trailing slash;
      // the file is absent. History rows may sit below the paths (the
      // argument rung puts paths first; the argument cap bounds history).
      const rows = dropdown.locator('.ui-completion-dropdown__row')
      const first = rows.nth(0)
      const second = rows.nth(1)
      await expect(first).toContainText('alpha/')
      await expect(first).toContainText('Directory')
      await expect(second).toContainText('beta/')
      await expect(second).toContainText('Directory')
      await expect(dropdown).not.toContainText('notes.txt')

      // The first Tab opened the dropdown with the first directory selected;
      // the next Tab moves to the second and previews it in the line.
      await expect(first).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('Tab')
      await expect(second).toHaveAttribute('aria-selected', 'true')
      const ghost = page.locator(`${INPUT} .nocx-editor-ghost`).first()
      await expect(ghost).toContainText('beta/')

      // Screenshot — the acceptance evidence the owner asked for.
      await page.screenshot({ path: '/tmp/nocx-c2-acceptance.png' })

      // Enter accepts the cycled-to candidate; nothing was submitted.
      await page.keyboard.press('Enter')
      await expect(page.locator(INPUT)).toHaveText('cd beta/', { timeout: 5000 })
      await expect(dropdown).not.toBeVisible()
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })
})
