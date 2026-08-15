import { test, expect, promptReady, type Page } from './harness'

/**
 * e2e: a snippet a person saved reaches a running program, filled in, and
 * unsubmitted (nocx-7ude, plan Task 13 — the snippets epic's gate).
 *
 * The whole sentence the epic promises, walked through the product's own
 * surfaces: the settings page authors the snippet, the chord opens the
 * palette while a program owns the pane and no command editor exists, the
 * ask form fills the blank, and the resolved text arrives at the program's
 * stdin WITHOUT a newline.
 *
 * What is observable, and what is not. Live xterm output is a WebGL canvas:
 * completed command output is frozen into a DOM scrollback block, and that
 * is the only thing the DOM can be asked about. So "the program received
 * the resolved text" is proved by running a program that echoes what it
 * read — the block then contains what actually crossed the seam — and "no
 * newline was sent" is proved by the absence of a new block plus the editor
 * still being hidden at the moment of the fire. The two halves are one
 * assertion; neither is enough alone.
 */

const INPUT = '.pane.active .nocx-editor-input'
const PANEL = '.ui-floating-panel[data-variant="snippet"]'
const ROW = `${PANEL} .ui-floating-panel__row`

/** The panel closes by emptying itself and flipping data-open — its root
 *  element stays mounted beside the pane (ui/floating-panel.ts), so
 *  "closed" is that attribute and never a disappearing node. */
async function expectPaletteClosed(page: Page): Promise<void> {
  await expect(page.locator(PANEL)).toHaveAttribute('data-open', 'false', { timeout: 10_000 })
}

/** The chord is matched on the physical key (snippets/chord.ts), which is
 *  what a Playwright key press produces. */
async function pressChord(page: Page): Promise<void> {
  await page.keyboard.press('Alt+Meta+p')
}

/** Author a snippet through the settings page — the only surface that can
 *  create one, and deliberately the route this check takes rather than
 *  seeding the document behind the product's back. */
async function createSnippet(page: Page, title: string, body: string): Promise<void> {
  await page.keyboard.press('Meta+,')
  await page.locator('.ui-grouped-nav__item[data-item="snippets"]').click()
  await expect(page.locator('.sn-root')).toBeVisible({ timeout: 10_000 })

  // The library is NOT empty on a fresh stand — the service seeds two
  // records when it first writes the document — so the create affordance is
  // the toolbar's, not the empty state's.
  await page.locator('[role="toolbar"]').getByRole('button', { name: '+ New snippet' }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'New snippet' })
  await expect(dialog).toBeVisible()
  await dialog.locator('#snippet-title').fill(title)
  // The body is a CM6 editor: click into its content and type, the way a
  // person does. `fill` has nothing to fill — there is no input element.
  await dialog.locator('.sn-body-editor .cm-content').click()
  await page.keyboard.type(body)
  await dialog.getByRole('button', { name: 'Create snippet' }).click()
  await expect(dialog).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.ui-record-row__title', { hasText: title })).toBeVisible({
    timeout: 10_000,
  })
}

/** Remove a snippet the same way, so a second run starts where this one
 *  did. Tolerant of it being gone already: an interrupted run must not
 *  leave the next one failing in its cleanup. */
async function removeSnippet(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Meta+,')
  await page.locator('.ui-grouped-nav__item[data-item="snippets"]').click()
  await expect(page.locator('.sn-root')).toBeVisible({ timeout: 10_000 })
  const del = page.locator(`[aria-label="Delete ${title}"]`)
  if ((await del.count()) === 0) return
  await del.first().click()
  await page
    .getByRole('dialog')
    .filter({ hasText: `Delete "${title}"?` })
    .getByRole('button', { name: 'OK', exact: true })
    .click()
  await expect(page.locator(`[aria-label="Delete ${title}"]`)).toHaveCount(0, { timeout: 10_000 })
}

/** Open a terminal tab and leave a program waiting on stdin: `read` holds
 *  the pane, so the command editor is hidden and the pty owns input — the
 *  state the palette exists for. Returns the number of completed blocks at
 *  that moment, which is what "nothing was submitted" is measured against.
 */
async function programWaitingOnStdin(page: Page, command: string): Promise<number> {
  // Back to the terminal tab: Settings opened as a second tab, and the
  // first one is the shell this check fires into.
  await page.locator('.nocx-tab').first().click()
  await promptReady(page)
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect(page.locator(INPUT)).not.toBeVisible({ timeout: 10_000 })
  return await page.locator('.cmd-block').count()
}

test.describe('a saved snippet reaches a running program', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test.afterEach(async ({ page }) => {
    await page.goto('/')
    await removeSnippet(page, 'e2e fill')
    await removeSnippet(page, 'e2e two lines')
  })

  test('fires filled in, without a newline, into the program reading stdin', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    // One env span and one ask span, exactly as the epic's criterion asks.
    // cwd rather than user: `user` is the SSH user and a local shell has
    // none, so {{env:user}} would REFUSE here — correctly, and that refusal
    // is the subject of the resolver's own tests, not of this one.
    await createSnippet(page, 'e2e fill', 'in-{{env:cwd}}-{{ask:tag}}')

    const blocksBefore = await programWaitingOnStdin(page, 'read x; printf \'got-%s\\n\' "$x"')

    // The chord reaches the palette even though no command editor exists —
    // the case the whole surface was built for.
    await pressChord(page)
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 10_000 })
    await page.locator(`${PANEL} .ui-floating-panel__filter input`).fill('e2e fill')
    await expect(page.locator(ROW)).toHaveCount(1)
    await page.keyboard.press('Enter')

    // The ask span turns the panel into the field form IN PLACE.
    const field = page.locator(`${PANEL} .ui-floating-panel__field input`)
    await expect(field).toBeVisible()
    await field.fill('alpha')
    await page.keyboard.press('Enter')

    // Half one: nothing was submitted. The palette closed on delivery, no
    // new completed block appeared, and the editor is still hidden — the
    // program is still the one holding input.
    await expectPaletteClosed(page)
    await expect(page.locator('.cmd-block')).toHaveCount(blocksBefore)
    await expect(page.locator(INPUT)).not.toBeVisible()

    // Half two: what was sent. The person presses Enter themselves, and the
    // program echoes back what it read.
    await page.keyboard.press('Enter')
    const block = page.locator('.cmd-block', { hasText: 'got-in-' }).first()
    await expect(block).toBeVisible({ timeout: 10_000 })
    // The ask answer arrived, and no span survived as literal text — the
    // env value is the session's own user, which the test does not pretend
    // to know, so it asserts what it can: the braces are gone.
    await expect(block).toContainText('-alpha')
    await expect(block).not.toContainText('{{')
  })

  test('a multi-line body is refused when the program has not enabled bracketed paste', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)
    await createSnippet(page, 'e2e two lines', 'first line\nsecond line')

    const blocksBefore = await programWaitingOnStdin(page, 'read x; printf \'got-%s\\n\' "$x"')

    await pressChord(page)
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 10_000 })
    await page.locator(`${PANEL} .ui-floating-panel__filter input`).fill('e2e two lines')
    await expect(page.locator(ROW)).toHaveCount(1)
    await page.keyboard.press('Enter')

    // The refusal renders IN the panel and stays: a newline would be read
    // as Return and run half the phrase, so nothing is sent at all.
    await expect(page.locator(PANEL)).toContainText('bracketed paste', { timeout: 10_000 })
    await expect(page.locator('.cmd-block')).toHaveCount(blocksBefore)

    await page.keyboard.press('Escape')
    await expectPaletteClosed(page)
    // And the program is still waiting: Enter ends it with the empty line
    // the person typed, not with anything the refused fire sent.
    await page.keyboard.press('Enter')
    await expect(page.locator('.cmd-block', { hasText: 'got-' }).first()).toBeVisible({
      timeout: 10_000,
    })
  })

  // The OTHER multi-line branch — bracketed paste ON, body delivered — is
  // NOT here, and that is a finding rather than an omission: neither a
  // program setting DECSET 2004 itself nor a nested interactive bash made
  // the mode read as active at fire time in this container, while the
  // renderer's own read answers correctly against the real parser
  // (renderers/xterm.test.ts, 'bracketed paste, read from the real
  // parser'). Either the bytes never reach xterm in the stand or something
  // resets the mode; nocx-8rtr.1 carries the question and this test.

  test('a snippet whose secret cannot be resolved refuses, and writes nothing', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)
    // This stand has no vault set up, so the reference cannot resolve. The
    // rule under test is the one §11.1 states: an unresolved name refuses
    // the whole fire — the literal {{secret:…}} must never reach a running
    // program's stdin.
    await createSnippet(page, 'e2e fill', 'psql {{secret:e2e-absent}}')

    const blocksBefore = await programWaitingOnStdin(page, 'read x; printf \'got-%s\\n\' "$x"')

    await pressChord(page)
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 10_000 })
    await page.locator(`${PANEL} .ui-floating-panel__filter input`).fill('e2e fill')
    await expect(page.locator(ROW)).toHaveCount(1)
    await page.keyboard.press('Enter')

    await expect(page.locator(PANEL)).toContainText('could not be resolved', { timeout: 10_000 })
    await expect(page.locator('.cmd-block')).toHaveCount(blocksBefore)

    await page.keyboard.press('Escape')
    await page.keyboard.press('Enter')
    const block = page.locator('.cmd-block', { hasText: 'got-' }).first()
    await expect(block).toBeVisible({ timeout: 10_000 })
    await expect(block).not.toContainText('secret:')
  })
})
