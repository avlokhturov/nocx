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
// update") is built through the transport's digest-poll loop (fm-w13): the
// panel sends files.watch for the root, the loop detects the change and
// emits files.changed, and the panel re-lists with nobody pressing
// anything. The remote half has no SSH host in this suite, so the host
// assertion is exercised in its local direction and asserted HARD: a local
// file's title is the basename alone — absence of the host marker is what
// means "this machine".
//
// The tree is rooted at the filesystem root `/` and stays there — the cwd
// never re-roots it. The root is asserted from the panel's own state
// (data-root), because the path left the header and "a row appeared" would
// not tell a correct tree from a wrong machine's. A cd REVEALS instead:
// the shell integration emits OSC 7, the frontend verifies it, and the
// panel — open on Files from cold start — expands the chain from / down to
// the new cwd and selects it. No tab switch is needed, which is itself the
// behaviour under test: the origin-change notification pushes the cwd to
// the panel (it used to be re-read only on tab change).

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
 *  verified). The panel — open on Files from cold start — REVEALS the new
 *  cwd through the origin-change notification: no tab switch, no click,
 *  which is the behaviour under test. The fixture's own row lands selected;
 *  expand it so its children (bigdir, notes.md) are rows the tests act on. */
async function openFilesAtFixture(page: Page) {
  await page.goto('/')
  await promptReady(page)
  await page.keyboard.type(`cd ${fixtureRoot}`)
  await page.keyboard.press('Enter')
  // The tab title is directoryLabel(cwd): it updates only once the frontend
  // processed the shell's OSC 7 report, i.e. exactly when the verified cwd
  // exists and the reveal has something to point at.
  await expect(page.locator(TAB_TITLE).first()).toContainText(fixtureBasename, {
    timeout: 20_000,
  })
  await expect(page.locator('[data-testid="files-panel"]')).toBeVisible()
  // The panel is rooted at the filesystem root, never at the cwd.
  await expect(page.locator('[data-testid="files-panel"]')).toHaveAttribute('data-root', '/', {
    timeout: 20_000,
  })
  // The reveal landed: the fixture's row is selected (the walk expanded
  // the chain from / down to it).
  const fixtureRow = page.locator(TREE_ROW, { hasText: fixtureBasename })
  await expect(fixtureRow).toHaveAttribute('data-selected', 'true', { timeout: 20_000 })
  // Expand the fixture so its children are rows the other tests click on.
  await fixtureRow.getByRole('button', { name: `Expand ${fixtureBasename}` }).click()
  await expect(page.locator('.ui-tree-row__name').filter({ hasText: 'bigdir' })).toBeVisible()
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
test('the Files icon toggles the panel; open, the tree shows the revealed fixture', async ({
  page,
}) => {
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

  // The tree shows the fixture under the revealed chain from the
  // filesystem root: the fixture's two children are visible rows, the
  // directory first (backend-owned ordering). The panel never re-rooted —
  // data-root stayed '/' (asserted inside openFilesAtFixture).
  await expect(page.locator('.ui-tree-row__name').filter({ hasText: 'bigdir' })).toBeVisible()
  await expect(page.locator('.ui-tree-row__name').filter({ hasText: 'notes.md' })).toBeVisible()
})

test('cd in the terminal reveals the directory in the tree — no click, no tab switch (acceptance)', async ({
  page,
}) => {
  await page.goto('/')
  await promptReady(page)
  // The panel is rooted at the filesystem root, whatever the shell has or
  // has not reported yet.
  await expect(page.locator('[data-testid="files-panel"]')).toHaveAttribute('data-root', '/', {
    timeout: 20_000,
  })

  await page.keyboard.type(`cd ${fixtureRoot}`)
  await page.keyboard.press('Enter')
  await expect(page.locator(TAB_TITLE).first()).toContainText(fixtureBasename, {
    timeout: 20_000,
  })

  // The tree revealed it: the fixture's row is selected and its ancestors
  // are expanded — with no click on the tree and no tab switch.
  const fixtureRow = page.locator(TREE_ROW, { hasText: fixtureBasename })
  await expect(fixtureRow).toHaveAttribute('data-selected', 'true', { timeout: 20_000 })
  await expect(fixtureRow).toBeVisible()
  // The panel still answers the filesystem root — the cd revealed, it did
  // not re-root.
  await expect(page.locator('[data-testid="files-panel"]')).toHaveAttribute('data-root', '/')
})

test('expanding a directory lists a page and "show next" reveals the rest', async ({ page }) => {
  await openFilesAtFixture(page)

  // Expand bigdir — the disclosure is the user's seam (aria-label from the
  // kit row). The fixture sits under the revealed chain from / (its depth
  // is its path's segment count minus the root), so bigdir's children sit
  // one deeper than the fixture's row.
  const childrenDepth = fixtureRoot.split('/').filter(Boolean).length + 1
  await page.locator('button[aria-label="Expand bigdir"]').click()

  // A page of the directory: PAGE_SIZE depth-N rows and a "show next"
  // button naming the remainder.
  await expect(page.locator(`${TREE_ROW}[data-depth="${childrenDepth}"]`)).toHaveCount(PAGE_SIZE)
  // The show-more button of the level being paged: the reveal expanded
  // /tmp too, whose own show-more button would match an unscoped locator.
  const showMore = page.locator(
    `.files-row[data-depth="${childrenDepth}"] [data-testid="files-show-more"]`,
  )
  await expect(showMore).toHaveText(`Show next ${BIGDIR_COUNT - PAGE_SIZE}`)

  // First "show next": another page lands, the remainder shrinks.
  await showMore.click()
  await expect(page.locator(`${TREE_ROW}[data-depth="${childrenDepth}"]`)).toHaveCount(
    PAGE_SIZE * 2,
  )
  await expect(showMore).toHaveText(`Show next ${BIGDIR_COUNT - PAGE_SIZE * 2}`)

  // Second "show next": the rest lands and the button is gone.
  await showMore.click()
  await expect(page.locator(`${TREE_ROW}[data-depth="${childrenDepth}"]`)).toHaveCount(BIGDIR_COUNT)
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

test('right-clicking a row copies the relative and the absolute path', async ({
  page,
  context,
}) => {
  // The copy rides the app's clipboard seam, which on this headless path
  // is navigator.clipboard — reading it back needs the read permission.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openFilesAtFixture(page)

  // The user's seam is the right-click; the menu appears with both copy
  // entries (and Show in Finder on this local tab).
  await page.locator('.files-row').filter({ hasText: 'notes.md' }).click({ button: 'right' })
  const menu = page.locator('[data-testid="files-context-menu"]')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Copy Relative Path' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Copy Absolute Path' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Show in Finder' })).toBeVisible()

  // Relative: as spelled from the tree root — the tree is rooted at the
  // filesystem root, so the fixture's file is spelled from / (no leading
  // slash: "the path in this tree").
  await menu.getByRole('menuitem', { name: 'Copy Relative Path' }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(join(fixtureRoot, 'notes.md').slice(1))

  // Absolute: the lexical absolute path of the row the user clicked.
  await page.locator('.files-row').filter({ hasText: 'notes.md' }).click({ button: 'right' })
  await page
    .locator('[data-testid="files-context-menu"]')
    .getByRole('menuitem', { name: 'Copy Absolute Path' })
    .click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(join(fixtureRoot, 'notes.md'))
})

test('writing to the file from outside nocx makes the row update without anyone pressing anything', async ({
  page,
}) => {
  await openFilesAtFixture(page)
  await expect(page.locator('.ui-tree-row__name').filter({ hasText: 'notes.md' })).toBeVisible()

  // The change signal is the backend's digest-poll over the watch set. The
  // baseline is taken synchronously inside files.watch (ws_files.go), so
  // the instant the watch response lands every change is delivered — no
  // waiting out a poll interval. Wait for the established mode, not for a
  // badge: the badge is a WARNING about a degraded watch and is dark while
  // polling is the designed mode, so a test that waited on it would be
  // asserting a defect.
  await expect(page.locator('[data-watch-mode="polling"]')).toBeAttached()
  await expect(page.locator(TREE_ROW).filter({ hasText: 'external.md' })).toHaveCount(0)

  // The change comes from the test process, not from the app: the panel's
  // watch set covers the root, the backend notices the new file, and
  // files.changed makes the panel re-list on its own.
  writeFileSync(join(fixtureRoot, 'external.md'), 'created outside nocx\n')

  await expect(page.locator('.ui-tree-row__name').filter({ hasText: 'external.md' })).toBeVisible({
    timeout: 20_000,
  })
})
