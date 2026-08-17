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
const DROPDOWN = '.ui-floating-panel[data-variant="completion"]'

/** The row the selection currently sits on. */
const selectedRow = (page: Page) =>
  page.locator(`${DROPDOWN} .ui-floating-panel__row[data-selected="true"]`)

/** A fixture directory this run owns; the session cds into it. */
const fixtureDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'nocx-e2e-cmp-'))

/** cd the session into a fixture dir and wait for the prompt (OSC 7 brings
 *  the new cwd with it). */
const cdInto = async (page: Page, dir: string) => {
  await page.keyboard.type(`cd ${dir}`)
  await page.keyboard.press('Enter')
  await promptReady(page)
}

/**
 * Wait until this tab actually HAS the command-existence snapshot.
 *
 * A spec that asserts something about command completion has the snapshot as
 * its premise, and the premise is not free. `nocx.bash` starts `compgen -c |
 * sort -u` in the background at source time and can only EMIT it from a
 * prompt — a shell idle in readline runs no traps, which `nocx.bash` and
 * suggest/controller.ts both state in as many words (nocx-z9s9.16). The first
 * prompt grants it 250 ms of grace and then gives up for good: the
 * `__nocx_snapshot_waiting` latch is set once, so every later delivery
 * depends on there being a LATER PROMPT.
 *
 * So on a machine where compgen outruns 250 ms the snapshot is simply absent
 * until the user runs something, and the product says exactly that in the
 * panel — "they arrive after your next command". Pressing Tab cannot advance
 * it. A spec that polls Tab waiting for the snapshot is therefore waiting for
 * an event its own polling has excluded, and will burn its entire budget.
 *
 * That is not hypothetical: it is why `no candidates` failed on both engines
 * in CI while passing locally. 250 ms is a claim about machine speed, and
 * `ubuntu-latest` is 4 vCPU where a developer's Mac is not — the same shape as
 * the tab-title races in multi-tab-input.spec.ts.
 *
 * This produces prompts, which is the one thing that does deliver it, and
 * checks the feature rather than a clock: `printf` is a bash builtin, so it is
 * in `compgen -c` on every machine, and offering it is proof the snapshot
 * landed. `true` is the no-op whose prompt carries it — a builtin, so it
 * cannot fail for want of a PATH entry.
 */
const PROBE = 'prin'

const commandSnapshotReady = async (page: Page) => {
  // A row for `printf` whose SOURCE BADGE says `command` — not merely a row
  // containing the text. Every spec in a run shares one home and one history
  // (nocx-8rda), and this file runs `printf` commands, so `prin` matches a
  // HISTORY row long before any snapshot exists. Matching on text alone made
  // the probe report "snapshot ready" against a history hit, and the caller
  // then failed on the real assertion with "still loading" — the probe
  // answering a different question from the one it was asked.
  const offered = page
    .locator(`${DROPDOWN} .ui-floating-panel__row`)
    .filter({ hasText: 'printf' })
    .filter({ has: page.locator('.ui-floating-panel__source', { hasText: 'command' }) })
    .first()
  await expect
    .poll(
      async () => {
        await page.keyboard.type(PROBE)
        await page.keyboard.press('Tab')
        // A BOUNDED WAIT, not isVisible(). isVisible() answers about this
        // instant, and the instant after Tab is before the panel has
        // rendered — so it reports "no snapshot" on a tab that has one, every
        // time, and the poll can never succeed.
        const ready = await offered
          .waitFor({ state: 'visible', timeout: 2_000 })
          .then(() => true)
          .catch(() => false)
        // Esc closes exactly the panel and keeps the draft; the draft is then
        // removed by as many Backspaces as were typed. Deliberately counted
        // rather than a clear-line binding: what this editor binds to Ctrl-U
        // is a question about the keymap, and getting it wrong leaves `prin`
        // in front of whatever the caller types next — a failure that would
        // read as a product defect.
        await page.keyboard.press('Escape')
        for (let i = 0; i < PROBE.length; i++) await page.keyboard.press('Backspace')
        if (ready) return 'ready'
        // The delivery point, and the only one. Run a no-op so the next
        // prompt carries the payload, exactly as the panel tells the user to.
        await page.keyboard.type('true')
        await page.keyboard.press('Enter')
        await promptReady(page)
        return 'pending'
      },
      { timeout: 45_000, intervals: [250] },
    )
    .toBe('ready')
}

test.describe('tab completion', () => {
  test('a real command completes: Pane opens the dropdown, arrows pick, Enter inserts', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)
    await promptReady(page)

    // The snapshot is this test's premise, not its subject — established
    // rather than assumed, because it is absent on a slow first prompt and
    // only a later prompt delivers it (see commandSnapshotReady).
    await commandSnapshotReady(page)

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

    // Same premise as the test above: ghost text is the top CANDIDATE, and
    // without the snapshot there are no command candidates to be top of.
    await commandSnapshotReady(page)

    await page.keyboard.type('pri')

    // The inline ghost (the completion tail of the top candidate) appears at
    // the caret. Its content is ranking-dependent; the accept is not.
    const ghost = page.locator(`${INPUT} .nocx-editor-ghost`).first()
    await expect(ghost).toBeVisible({ timeout: 5000 })

    // Read it only once it has SETTLED. Candidates arrive in batches — the
    // command snapshot is local and lands first, the history query is a
    // round trip and lands after — and every batch re-ranks, so the ghost
    // legitimately changes for as long as one is outstanding. Reading it
    // once and pressing Right afterwards compares a value from before the
    // last batch with a line accepted after it: the suite failed here with
    // ghost "ntenv" and a line of `printf …` recalled from another spec's
    // history, and only in a full run, because only there is the history
    // long enough to outrank a command name (nocx-58gq). Two equal reads a
    // poll apart mean no batch is still landing.
    let tail = ''
    await expect
      .poll(
        async () => {
          const now = (await ghost.innerText()).trim()
          const settled = now !== '' && now === tail
          tail = now
          return settled
        },
        { timeout: 10_000, intervals: [250, 250, 250, 250] },
      )
      .toBe(true)
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

      // The probes are DIRECTORIES: `cd` takes directories only (the
      // dirs-only table), so a file would be filtered out of its completion
      // and this test would fail for the wrong reason.
      //
      // TWO of them, sharing a prefix. One would be a UNIQUE completion, and
      // a unique completion is applied straight to the line without ever
      // opening a dropdown (controller.applyUniqueCompletion) — so a
      // single-probe fixture cannot see the list this test is about. It used
      // to have one, and read the panel that opened afterwards on the newly
      // entered (empty) directory as a failure of fs.complete.
      const run = Date.now().toString(36)
      const stem = `zzz-e2e-cmp-${run}`
      const probe = `${stem}-probe`
      fs.mkdirSync(path.join(fixture, probe))
      fs.mkdirSync(path.join(fixture, `${stem}-sibling`))

      await cdInto(page, fixture)

      // `cd ./zzz-e2e-cmp-<run>` + Tab: the local path provider asks the
      // backend (fs.complete) and lists both. The typed prefix carries the
      // run's own random, so a previous run's recorded history line can
      // never start with it — no cross-provider pollution.
      await page.keyboard.type(`cd ./${stem}`)
      await page.keyboard.press('Tab')
      const dropdown = page.locator(DROPDOWN).first()
      await expect(dropdown).toBeVisible({ timeout: 5000 })
      await expect(dropdown).toContainText(probe, { timeout: 5000 })
      await expect(dropdown).toContainText(`${stem}-sibling`, { timeout: 5000 })

      await page.keyboard.press('Enter')
      // A directory keeps its trailing slash. The rows are alphabetical and
      // `-probe` precedes `-sibling`, so Enter on the opening selection takes
      // the probe.
      await expect(page.locator(INPUT)).toHaveText(`cd ./${probe}/`, { timeout: 5000 })
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })

  test('no candidates: Pane opens a row that says nothing matched — never silence', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)
    await promptReady(page)

    // A prefix that matches no command, no history row and no path — and the
    // nonce is what makes the third clause true.
    //
    // It used to be the fixed string 'zzznocxe2enope', and the last thing this
    // test does is press Enter, which RUNS that line and records it in history.
    // History lives in the stand's home, which every spec in a run shares and
    // both browser projects share, so chromium's pass was what made webkit's
    // premise false: the second project typed a prefix its own history now held,
    // the panel correctly offered the history row, and the poll spent 45 seconds
    // waiting for a "No matches" the product had no reason to say. Whichever
    // project ran second lost, which is what made it look like a race
    // (nocx-z9s9.6, and the nocx-8rda shape underneath it).
    // The premise, established rather than waited for. What this test is
    // about is the row a user sees when nothing matches — which only means
    // anything once the shell HAS command names to fail to match against.
    // Getting them needs a prompt, not a Tab; see commandSnapshotReady.
    await commandSnapshotReady(page)

    const nope = `zzznocxe2enope${Date.now().toString(36)}`
    await page.keyboard.type(nope)

    const dropdown = page.locator(DROPDOWN).first()
    await page.keyboard.press('Tab')
    await expect(dropdown).toBeVisible({ timeout: 5_000 })
    // Now that the snapshot is known to be present, "still loading" is a
    // defect rather than a slow machine, and this asserts the real property
    // directly instead of tolerating it in a retry loop.
    await expect(dropdown).toContainText('No matches', { timeout: 5_000 })

    // One non-selectable row: never the selected variance, no hint footer.
    const rows = dropdown.locator('.ui-floating-panel__row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('data-empty', 'true')
    await expect(rows.first()).not.toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(INPUT)).toHaveText(nope)

    // Enter falls through to the editor's submit — nothing was selected and
    // nothing blocked the key; the shell runs the line.
    await page.keyboard.press('Enter')
    await promptReady(page)
  })

  test('cd onto a directory holding only a file names why there is nothing to choose', async ({
    page,
  }) => {
    const fixture = fixtureDir()
    // The owner's exact case: `~/Downloads` holds one entry, a file, and cd
    // takes directories only — zero candidates, and the reason is specific.
    const downloads = path.join(fixture, 'Downloads')
    fs.mkdirSync(downloads)
    fs.writeFileSync(path.join(downloads, 'nocx-backup.enc'), 'x')
    try {
      await page.goto('/')
      await expect(page.locator('.nocx-tab')).toHaveCount(1)
      await promptReady(page)
      await cdInto(page, fixture)

      await page.keyboard.type(`cd ${downloads}/`)
      await page.keyboard.press('Tab')
      const dropdown = page.locator(DROPDOWN).first()
      await expect(dropdown).toBeVisible({ timeout: 5000 })
      const empty = dropdown.locator('.ui-floating-panel__row[data-empty="true"]')
      await expect(empty).toHaveCount(1)
      await expect(empty.first()).toContainText('No subdirectories in Downloads')
      await page.screenshot({ path: '/tmp/nocx-c3-cd-onto-files.png' })

      // Enter is not blocked by the row: the line submits as typed.
      await page.keyboard.press('Enter')
      await promptReady(page)
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })

  test('erasing the line closes the panel entirely — no footer-only panel', async ({ page }) => {
    const fixture = fixtureDir()
    // Two directories, not one. A single candidate is a UNIQUE completion and
    // is applied straight to the line without opening a dropdown
    // (controller.applyUniqueCompletion), so a one-directory fixture never
    // reaches the state this test is about — the open panel it then erases.
    fs.mkdirSync(path.join(fixture, 'alpha'))
    fs.mkdirSync(path.join(fixture, 'beta'))
    try {
      await page.goto('/')
      await expect(page.locator('.nocx-tab')).toHaveCount(1)
      await promptReady(page)
      await cdInto(page, fixture)

      await page.keyboard.type('cd ')
      await page.keyboard.press('Tab')
      const dropdown = page.locator(DROPDOWN).first()
      await expect(dropdown).toBeVisible({ timeout: 5000 })
      await expect(dropdown.locator('.ui-floating-panel__row').first()).toContainText('alpha/')

      // Erase the whole line: the panel must CLOSE, not hang showing only
      // its footer.
      await page.keyboard.press('Control+a')
      await page.keyboard.press('Backspace')
      await expect(dropdown).not.toBeVisible({ timeout: 5000 })
      await expect(page.locator(INPUT)).toHaveText('')
      await page.screenshot({ path: '/tmp/nocx-c3-erased-closed.png' })
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true })
    }
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
      // The ghost shows the top candidate BEFORE the Tab: what the user is
      // looking at is what the first Tab must settle on (completion pass
      // 4's "the first Tab takes what is shown").
      const ghost = page.locator(`${INPUT} .nocx-editor-ghost`).first()
      await expect(ghost).toBeVisible({ timeout: 5000 })
      const ghostText = (await ghost.innerText()).trim()
      expect(ghostText.length).toBeGreaterThan(0)

      await page.keyboard.press('Tab')
      const dropdown = page.locator(DROPDOWN).first()
      await expect(dropdown).toBeVisible({ timeout: 5000 })

      // The two directories, each marked Directory with a trailing slash;
      // the file is absent. History rows may sit below the paths (the
      // argument rung puts paths first; the argument cap bounds history).
      const rows = dropdown.locator('.ui-floating-panel__row')
      const first = rows.nth(0)
      const second = rows.nth(1)
      await expect(first).toContainText('alpha/')
      await expect(first).toContainText('Directory')
      await expect(second).toContainText('beta/')
      await expect(second).toContainText('Directory')
      await expect(dropdown).not.toContainText('notes.txt')
      // The FIRST Tab SETTLED on the ghosted candidate: the row the
      // dropdown opened on is the row the ghost was showing — it did not
      // advance to the next folder.
      const settled = (
        await selectedRow(page).locator('.ui-collection-row__info').innerText()
      ).trim()
      expect(settled).toBe(ghostText)
      // Let the list settle (a late history batch may still merge in — a
      // list that grows legitimately re-measures), then pin the width.
      await page.waitForTimeout(500)
      const widthAtOpen = (await dropdown.boundingBox())!.width
      await page.screenshot({ path: '/tmp/nocx-c4-tab-settled.png' })

      // The next Tab moves to the second candidate and previews it in the
      // line — and the panel's width does not change between the presses
      // (the owner's "every Tab press makes the window narrower").
      await page.keyboard.press('Tab')
      await expect(second).toHaveAttribute('aria-selected', 'true')
      const ghost2 = page.locator(`${INPUT} .nocx-editor-ghost`).first()
      await expect(ghost2).toContainText('beta/')
      const widthAfterCycle = (await dropdown.boundingBox())!.width
      expect(widthAfterCycle).toBe(widthAtOpen)
      await page.screenshot({ path: '/tmp/nocx-c4-tab-cycled.png' })

      // Content-sized: the panel hugs its rows, it never spans the pane.
      const box = await dropdown.boundingBox()
      const pane = await page.locator('.pane.active').first().boundingBox()
      expect(box).not.toBeNull()
      expect(pane).not.toBeNull()
      expect(box!.width).toBeLessThan(pane!.width * 0.75)
      expect(box!.width).toBeGreaterThanOrEqual(300)
      expect(box!.width).toBeLessThanOrEqual(640)

      // Screenshot — the acceptance evidence the owner asked for.
      await page.screenshot({ path: '/tmp/nocx-c3-acceptance.png' })

      // Enter accepts the cycled-to candidate; nothing was submitted.
      await page.keyboard.press('Enter')
      await expect(page.locator(INPUT)).toHaveText('cd beta/', { timeout: 5000 })
      // Accepting a DIRECTORY re-queries into it — the owner's "Tab jumps to
      // the next folder" — so the panel stays up describing where the caret
      // now is. beta/ is empty, and the panel says so rather than "No
      // matches": nothing was typed for anything to fail to match, and the
      // completion the user just made succeeded (nocx-azxe.5).
      await expect(dropdown).toContainText('empty', { timeout: 5000 })
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })

  test('reports 2-4: last-segment rows, a readable match chip, and no clipped glyphs', async ({
    page,
  }) => {
    const fixture = fixtureDir()
    // The owner's session: a multi-level path with a long directory name —
    // the case that used to repeat `repos/meshynet/` in every row and clip
    // `repos/meshynet/graphify-ou…` at the panel's ceiling.
    fs.mkdirSync(path.join(fixture, 'repos', 'meshynet'), { recursive: true })
    fs.mkdirSync(path.join(fixture, 'repos', 'meshynet', 'bin'))
    fs.mkdirSync(path.join(fixture, 'repos', 'meshynet', 'graphify-output'))
    // A sibling under the same `gr` prefix. Without it `gr` is a UNIQUE
    // completion, applied straight to the line with no dropdown to read
    // (controller.applyUniqueCompletion). Named to sort AFTER
    // graphify-output so the row assertions below still name row 0.
    fs.mkdirSync(path.join(fixture, 'repos', 'meshynet', 'grz-sibling'))
    try {
      await page.goto('/')
      await expect(page.locator('.nocx-tab')).toHaveCount(1)
      await promptReady(page)
      await cdInto(page, fixture)

      // ── report 3: the row shows the LAST SEGMENT, never the typed
      //    prefix repeated — `graphify-output/`, not
      //    `repos/meshynet/graphify-output/`. Typing a PARTIAL segment
      //    (`gr`) also leaves a match to assert report 2 against. ──
      await page.keyboard.type('cd repos/meshynet/gr')
      await page.keyboard.press('Tab')
      const dropdown = page.locator(DROPDOWN).first()
      await expect(dropdown).toBeVisible({ timeout: 8000 })
      const rows = dropdown.locator('.ui-floating-panel__row')
      await expect(rows.first()).toBeVisible({ timeout: 5000 })
      // A PARTIAL segment (`gr`) narrows the listing to the matching
      // entries, each showing its LAST SEGMENT — never `repos/meshynet/…`
      // repeated in every row.
      await expect(rows.nth(0)).toContainText('graphify-output/')
      await expect(rows.nth(1)).toContainText('grz-sibling/')
      await expect(dropdown).not.toContainText('repos/meshynet/graphify-output')
      const box = await dropdown.boundingBox()
      expect(box).not.toBeNull()
      // Content-sized and never the pane (report 5's rule, this shape).
      const pane = await page.locator('.pane.active').first().boundingBox()
      expect(box!.width).toBeLessThan(pane!.width * 0.75)
      expect(box!.width).toBeLessThanOrEqual(640)
      console.log(`E2E completion panel width: ${box!.width}px (report 3 shape)`)

      // ── report 2: the match is a real highlight, asserted from the
      //    browser's own computed styles.
      //
      //    The channel changed on 2026-08-03 and the assertion follows it.
      //    It used to be a background wash, which sits BEHIND the row's own
      //    glyphs: raising its alpha to make it brighter darkens the
      //    letters on it, and measured across the theme catalogue there is
      //    no alpha that reads as emphasis (40% leaves 3.45:1, 55% is
      //    already 2.44:1). The accent went into the TEXT instead. So the
      //    proof is that the matched glyphs differ in COLOUR from the row's
      //    text — and that <mark>'s user-agent background is off, which is
      //    a real trap: dropping the background declaration does not remove
      //    a background, it reveals the browser's yellow one. ──
      const match = rows.nth(0).locator('mark.ui-floating-panel__match').first()
      await expect(match).toBeVisible({ timeout: 5000 })
      await expect(match).toHaveText('gr')
      const [markColor, rowColor, markBg] = await match.evaluate((el) => {
        const mark = el as HTMLElement
        const row = mark.closest('.ui-floating-panel__row') as HTMLElement
        return [
          getComputedStyle(mark).color,
          getComputedStyle(row).color,
          getComputedStyle(mark).backgroundColor,
        ]
      })
      expect(markColor).not.toBe(rowColor)
      expect(markBg).toBe('rgba(0, 0, 0, 0)')
      console.log(`E2E match: colour ${markColor} vs row ${rowColor}, bg ${markBg} (report 2)`)

      // ── report 4: a row longer than the ceiling ellipsises inside the
      //    panel — the panel never grows past the ceiling to fit it. ──
      const infoOverflow = await rows
        .nth(0)
        .locator('.ui-collection-row__info')
        .evaluate((el) => getComputedStyle(el as HTMLElement).textOverflow)
      expect(infoOverflow).toBe('ellipsis')
      await page.screenshot({ path: '/tmp/nocx-reports-234.png' })
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })
})
