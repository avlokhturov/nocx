import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './harness'
import { promptReady } from './harness'
import type { Page } from '@playwright/test'
//   From a cold start the Files icon is FIRST in the activity bar, present
//   and enabled, and the panel is OPEN on Files (the product's cold-start
//   state — §7's "with the panel collapsed" premise is stale and needs
//   amending: mountSidebar activates the first registered view and
//   createSidebarState is "first view active and panel open", behaviour
//   that predates this epic); clicking the Files icon TOGGLES the panel
//   (VS Code semantics: clicking the active view's icon closes it), and
//   with the panel open the tree shows the origin's root; expanding a
//   directory lists a page of it and "show next" reveals the rest; clicking
//   a file opens a tab whose content matches the file; and its title
//   carries the host iff the origin is remote.
//
// The watching clause ("writing to the file from outside nocx makes the row
// update") is NOT built: local.Watch returns a typed unavailable error on
// purpose. It is deliberately not tested, not skipped. The remote half has
// no SSH host in this suite, so the host assertion is exercised in its local
// direction and asserted HARD: a local file's title is the basename alone —
// absence of the host marker is what means "this machine".
//
// The root is made deterministic through the product's own seam: the shell
// integration emits OSC 7 after `cd`, the frontend verifies it, and D2 lets
// a verified cwd override the provider root. The tree must then root at the
// fixture. To reach that state the tab must be switched away and back after
// the cd — the origin the panel follows is the snapshot taken when the tab
// became active (main.tsx feeds it on tab change only), which is itself the
// behaviour under test.

// ── Fixture ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50
const BIGDIR_COUNT = 120

let fixtureRoot: string
let fixtureBasename: string

test.beforeAll(() => {
  // Created by the test under the isolated HOME when the suite declares one
  // (headless path), else under the system tmp dir (wails path).
  const base = process.env.NOCX_E2E_HOME_DIR ?? tmpdir()
  fixtureRoot = mkdtempSync(join(base, 'nocx-files-e2e-'))
  fixtureBasename = fixtureRoot.split('/').pop() as string
  writeFileSync(join(fixtureRoot, 'notes.md'), 'hello from the fixture\n')
  const bigdir = join(fixtureRoot, 'bigdir')
  mkdirSync(bigdir)
  for (let i = 0; i < BIGDIR_COUNT; i++) {
    writeFileSync(join(bigdir, `f${String(i).padStart(3, '0')}.txt`), `file ${i}\n`)
  }
})

test.afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

// ── Selectors ──────────────────────────────────────────────────────────────

const VIEW_BTN = 'button[data-view]'
const FILES_BTN = 'button[data-view="files"]'
const TAB = '.nocx-tab'
const TAB_TITLE = '.nocx-tab-title'
const TREE_ROW = '.ui-tree-row'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Make the active tab's origin the fixture: cd there (OSC 7 makes the cwd
 *  verified), then switch away and back so the origin signal the panel
 *  follows is refreshed from the live tab (main.tsx snapshots it on tab
 *  change). Then open the Files view. */
async function openFilesAtFixture(page: Page) {
  await page.goto('/')
  await promptReady(page)
  await page.keyboard.type(`cd ${fixtureRoot}`)
  await page.keyboard.press('Enter')
  // The tab title is directoryLabel(cwd): it updates only once the frontend
  // processed the shell's OSC 7 report, i.e. exactly when cwdVerified turns
  // true and files.open will be handed the fixture as rootPath.
  await expect(page.locator(TAB_TITLE).first()).toContainText(fixtureBasename, {
    timeout: 20_000,
  })
  await page.locator('[aria-label="New tab"]').click()
  await expect(page.locator(TAB)).toHaveCount(2)
  await page.locator(TAB).first().click()
  await expect(page.locator('[data-testid="files-panel"]')).toBeVisible()
  await expect(page.locator('[data-testid="files-root-path"]')).toContainText(fixtureBasename, {
    timeout: 20_000,
  })
}
test('cold start: the Files icon is first in the activity bar, present and enabled; the panel is open on Files', async ({
  page,
}) => {
  await page.goto('/')

  // First view button in the activity bar is Files.
  await expect(page.locator(VIEW_BTN).first()).toHaveAttribute('data-view', 'files')
  // Present, visible, enabled.
  await expect(page.locator(FILES_BTN)).toBeAttached()
  await expect(page.locator(FILES_BTN)).toBeVisible()
  await expect(page.locator(FILES_BTN)).toBeEnabled()
  // The product's cold start is the panel OPEN on the first registered
  // view: mountSidebar activates it (sidebar.tsx:376-390, "Fix nocx-rp2j")
  // and createSidebarState is "first view active and panel open" — both
  // predate this epic, so §7's "from a cold start with the panel collapsed"
  // premise is stale and needs amending. Assert what the product correctly
  // does: the panel is open and showing Files.
  await expect(page.locator('#sidebar')).not.toHaveClass(/collapsed/)
  await expect(page.locator('[data-testid="files-panel"]')).toBeVisible()
})
test('the Files icon toggles the panel; open, the tree shows the origin root', async ({ page }) => {
  await openFilesAtFixture(page)

  // The product's cold start is OPEN on Files, so §7's "clicking it opens
  // the panel" is non-idempotent: clicking the ALREADY-active view's icon
  // collapses the panel (VS Code semantics, setActiveView in
  // sidebar-model.ts). Express the real toggle: one click closes, a second
  // re-opens on the same view, and the tree is there when it is open.
  await expect(page.locator('#sidebar')).not.toHaveClass(/collapsed/)
  await page.locator(FILES_BTN).click()
  await expect(page.locator('#sidebar')).toHaveClass(/collapsed/)
  await page.locator(FILES_BTN).click()
  await expect(page.locator('#sidebar')).not.toHaveClass(/collapsed/)

  // The tree shows the fixture: the root header names it, and its two
  // children are the depth-0 rows, the directory first (backend-owned
  // ordering).
  const rows = page.locator(`${TREE_ROW}[data-depth="0"]`)
  await expect(rows).toHaveCount(2)
  await expect(page.locator('.ui-tree-row__name').filter({ hasText: 'bigdir' })).toBeVisible()
  await expect(page.locator('.ui-tree-row__name').filter({ hasText: 'notes.md' })).toBeVisible()
})

test('expanding a directory lists a page and "show next" reveals the rest', async ({ page }) => {
  await openFilesAtFixture(page)

  // Expand bigdir — the disclosure is the user's seam (aria-label from the
  // kit row).
  await page.locator('button[aria-label="Expand bigdir"]').click()

  // A page of the directory: PAGE_SIZE depth-1 rows and a "show next"
  // button naming the remainder.
  await expect(page.locator(`${TREE_ROW}[data-depth="1"]`)).toHaveCount(PAGE_SIZE)
  const showMore = page.locator('[data-testid="files-show-more"]')
  await expect(showMore).toHaveText(`Show next ${BIGDIR_COUNT - PAGE_SIZE}`)

  // First "show next": another page lands, the remainder shrinks.
  await showMore.click()
  await expect(page.locator(`${TREE_ROW}[data-depth="1"]`)).toHaveCount(PAGE_SIZE * 2)
  await expect(showMore).toHaveText(`Show next ${BIGDIR_COUNT - PAGE_SIZE * 2}`)

  // Second "show next": the rest lands and the button is gone.
  await showMore.click()
  await expect(page.locator(`${TREE_ROW}[data-depth="1"]`)).toHaveCount(BIGDIR_COUNT)
  await expect(showMore).toHaveCount(0)

  // The whole directory is present, nothing duplicated or skipped (D10
  // ordering is backend-owned; the test names the first and last rows).
  await expect(page.locator('.ui-tree-row__name').filter({ hasText: 'f000.txt' })).toBeVisible()
  await expect(page.locator('.ui-tree-row__name').filter({ hasText: 'f119.txt' })).toBeVisible()
})

test('clicking a file opens a tab whose content matches the file and whose title is the basename alone', async ({
  page,
}) => {
  await openFilesAtFixture(page)

  await page.locator('.files-row').filter({ hasText: 'notes.md' }).click()

  // A second tab opens with the file content.
  await expect(page.locator(TAB)).toHaveCount(2)
  await expect(page.locator('.file-viewer__editor')).toContainText('hello from the fixture', {
    timeout: 20_000,
  })

  // Local half asserted hard: the title is the basename ALONE — no host
  // prefix, no "host · name", nothing else.
  const viewerTitle = page.locator(TAB_TITLE).filter({ hasText: 'notes.md' })
  await expect(viewerTitle).toHaveText('notes.md')
  // The remote form would be "host · notes.md"; no tab may carry the
  // separator on a local origin.
  await expect(page.locator(TAB_TITLE).filter({ hasText: '·' })).toHaveCount(0)
})
