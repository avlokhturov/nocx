import { test, expect, promptReady, type Page } from './harness'

/**
 * e2e: THE EPIC'S HEADLINE (nocx-isoph, and nocx-isoph.5's first four
 * criteria).
 *
 * A person creates a workspace and it is minted together with its first tab.
 * They switch between it and the default by clicking its pill, and THE DEFAULT
 * WORKSPACE DRAWS NOTHING AT ALL — no pill, no header, no colour — before
 * another workspace exists and after. They close the workspace; the dialog
 * names what is live before anything dies, and the window is back in the
 * default with the tab it left there.
 *
 * WRITTEN AGAINST THE REWORK, and the first version was not — which is the
 * only reason this file is worth a note. §4.3 gave the horizontal strip ONE
 * chip: the default wore it too, with an empty label, and every other
 * workspace was reachable only through that chip's dropdown. This spec asserted
 * exactly that — a visible chip with `toHaveText('')` on a fresh stand — and
 * the design was withdrawn before it ever ran, because the dropdown made every
 * other workspace unreachable except through a menu. The shipped design puts
 * every workspace in the row as its own pill, one click switches, and the
 * default draws no pill BECAUSE it draws no chrome (§4.2). The spec and the
 * unit test over the same seam (frontend/src/panes-workspaces.test.ts) had
 * been contradicting each other, with the unit test right.
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
/** A workspace's pill. The DEFAULT has none, so a bare count of these is also
 *  the count of named workspaces. */
const CHIP = '.nocx-workspace-chip .ui-button'
const MENU_ITEM = '.ui-context-menu__item'
const MORE = '[aria-label="More"]'
const HEADING = '.tabstrip-group-heading'
/** The dialog that is UP. A closed `<dialog>` keeps its panel in the DOM —
 *  the quick-connect palette is one — so a bare `.nocx-dialog__panel` matches
 *  two elements and Playwright's strict mode is right to refuse it. */
const DIALOG = 'dialog[open] .nocx-dialog__panel'

/** The pill of the workspace called `name`. */
function pill(page: Page, name: string) {
  return page.locator(CHIP).filter({ hasText: name })
}

/** A workspace's own actions live on its pill's CONTEXT menu — a plain click
 *  is switching, which is the whole point of the rework. */
async function openWorkspaceMenu(page: Page, name: string): Promise<void> {
  await pill(page, name).click({ button: 'right' })
  await expect(page.locator(MENU_ITEM).first()).toBeVisible({ timeout: 10_000 })
}

async function pickWorkspaceAction(page: Page, name: string, label: string): Promise<void> {
  await openWorkspaceMenu(page, name)
  await page.locator(MENU_ITEM, { hasText: label }).first().click()
  await expect(page.locator(MENU_ITEM)).toHaveCount(0, { timeout: 10_000 })
}

/** Creating one is a row in the STRIP's menu, not on any pill: it is not an
 *  action on a workspace, so it does not live where a workspace's actions do. */
async function newWorkspace(page: Page, name: string): Promise<void> {
  await page.locator(MORE).first().click()
  await page.locator(MENU_ITEM, { hasText: 'New workspace' }).first().click()
  const field = page.locator(`${DIALOG} .ui-text-field__input`)
  await expect(field).toBeVisible({ timeout: 10_000 })
  await field.fill(name)
  // "Create", not "Save": the create and edit dialogs are the same FORM with
  // different submit labels (name-colour-dialog.tsx), which is deliberate —
  // the verb is the one thing that tells a person which of the two they are
  // looking at.
  await page.locator(`${DIALOG} button`, { hasText: 'Create' }).click()
}

/** The tabs a person can actually SEE. A folded workspace's rows stay in the
 *  row and are hidden, so a bare `.nocx-tab` count answers a different
 *  question from the one every assertion here is asking. */
function shownTabIds(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.nocx-tab'))
      .filter((t) => t.getAttribute('data-hidden') !== 'true')
      .map((t) => t.getAttribute('data-pane-id')),
  )
}

test.describe('a workspace is a group of tabs, and the window shows one at a time', () => {
  test('created with its first tab, switched between, and closed — while the default never renders', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator(TAB)).toHaveCount(1, { timeout: 15_000 })
    await promptReady(page)

    // ── The default workspace, alone: no pill, no header, no colour ──────
    await expect(page.locator(CHIP)).toHaveCount(0)
    await expect(page.locator(HEADING)).toHaveCount(0)
    await expect(page.locator(`${TAB}[data-colour]`)).toHaveCount(0)
    const [inDefault] = await shownTabIds(page)
    expect(inDefault).not.toBeNull()

    // ── New workspace: created with its first tab ────────────────────────
    await newWorkspace(page, 'e2e-refactor-auth')

    // It arrives with a pill wearing its name, and the window follows it. The
    // DEFAULT's tabs are top-level and never fold (§4.2 — folding a workspace
    // that draws no pill would put its tabs out of reach), so what is on show
    // is the default's tab and the new workspace's, and they are not the same.
    await expect(pill(page, 'e2e-refactor-auth')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(CHIP)).toHaveCount(1)
    await promptReady(page)
    await expect.poll(() => shownTabIds(page), { timeout: 15_000 }).toHaveLength(2)
    const shown = await shownTabIds(page)
    const inWorkspace = shown.find((id) => id !== inDefault)
    expect(inWorkspace).toBeDefined()

    // The default STILL draws nothing. "Not a counter": another workspace
    // exists now, and the default's chrome is exactly what it was.
    await expect(page.locator(HEADING)).toHaveCount(0)
    await expect(page.locator(CHIP)).toHaveCount(1)

    // ── A second one, so there is a workspace to fold ────────────────────
    await newWorkspace(page, 'e2e-ship-it')
    await expect(pill(page, 'e2e-ship-it')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(CHIP)).toHaveCount(2)

    // The first workspace is folded to its pill now: its tab is still a row,
    // and it is not on show.
    await expect
      .poll(() => shownTabIds(page), {
        timeout: 15_000,
        message: 'the first workspace never folded when the second took the window',
      })
      .not.toContain(inWorkspace)

    // ── One click on a pill is the whole of switching ────────────────────
    await pill(page, 'e2e-refactor-auth').click()
    await expect
      .poll(() => shownTabIds(page), {
        timeout: 15_000,
        message: 'clicking the pill did not bring its tabs back',
      })
      .toContain(inWorkspace)
    // …and the default's tab came with it, because the default never folds.
    expect(await shownTabIds(page)).toContain(inDefault)

    // ── Closing it asks first, and names what it takes ───────────────────
    await pickWorkspaceAction(page, 'e2e-refactor-auth', 'Close workspace')
    const dialog = page.locator(DIALOG)
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog).toContainText('e2e-refactor-auth')
    await expect(dialog).toContainText('1 tab')
    await dialog.locator('button', { hasText: 'Close workspace' }).click()

    // The workspace is gone — pill and tab both — and the tab the default
    // held is still there.
    await expect(pill(page, 'e2e-refactor-auth')).toHaveCount(0, { timeout: 15_000 })
    await expect
      .poll(() => shownTabIds(page), {
        timeout: 15_000,
        message: 'the tab the default workspace held did not survive the close',
      })
      .toContain(inDefault)
    await expect.poll(() => shownTabIds(page), { timeout: 15_000 }).not.toContain(inWorkspace)
  })
})
