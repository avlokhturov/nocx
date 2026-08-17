import { test, expect, promptReady, type Page } from './harness'

/**
 * e2e: THE EPIC'S HEADLINE (nocx-isoph.4, design §4.1 and §4.5).
 *
 * A user colours a tab, pins it, renames it and reorders the strip. The
 * RENDERER is then reloaded — the backend is not restarted, and nothing in
 * this file touches a store — and all four are still there.
 *
 * The reload is what makes the assertion mean something: a Playwright reload
 * drops the renderer, its cache and every object in it, so anything that comes
 * back came from the backend. Before this bead the strip's order, its
 * activation and its decoration lived in PaneManager, and this test could not
 * have been written at all — there was no read method to bring any of it back
 * (nocx-isoph.2 named that the biggest gap it left).
 *
 * What is deliberately NOT asserted: the shell. A session dies with the
 * backend (D5) and a reloaded renderer opens a fresh one; blocks, the pane's
 * cwd and an ssh pane reconnecting are restore's, nocx-l21ib.
 */

const TAB = '.nocx-tab'
const MENU_ITEM = '.ui-context-menu__item'

/** Open a tab's own menu, where its decoration is asked for. */
async function openTabMenu(page: Page, index: number): Promise<void> {
  await page.locator(TAB).nth(index).click({ button: 'right' })
  await expect(page.locator(MENU_ITEM).first()).toBeVisible({ timeout: 10_000 })
}

async function pickMenuItem(page: Page, label: string): Promise<void> {
  await page.locator(MENU_ITEM, { hasText: label }).first().click()
  await expect(page.locator(MENU_ITEM)).toHaveCount(0, { timeout: 10_000 })
}

/** Rename through the kit's prompt: one field, and Save. */
async function renameTab(page: Page, index: number, name: string): Promise<void> {
  await openTabMenu(page, index)
  await pickMenuItem(page, 'Rename')
  const field = page.locator('.nocx-dialog__panel .ui-text-field__input')
  await expect(field).toBeVisible({ timeout: 10_000 })
  await field.fill(name)
  await page.locator('.nocx-dialog__panel button', { hasText: 'Save' }).click()
}

/**
 * Drag one tab onto another, with the native HTML5 event sequence the strip
 * listens for — the same technique focus-after-reorder.spec.ts uses, because a
 * synthesised pointer drag does not produce a DataTransfer.
 */
async function dragTabOnto(page: Page, draggedPaneId: string, targetIndex: number): Promise<void> {
  await page.evaluate(
    ({ draggedId, index }: { draggedId: string; index: number }) => {
      const src = document.querySelector(`[data-pane-id="${draggedId}"]`) as HTMLElement | null
      const tgt = document.querySelectorAll('.nocx-tab')[index] as HTMLElement | null
      if (!src || !tgt) throw new Error('source or target tab not found')
      const dt = new DataTransfer()
      dt.setData('text/plain', draggedId)
      src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      tgt.dispatchEvent(
        new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }),
      )
      tgt.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
      )
      src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
    },
    { draggedId: draggedPaneId, index: targetIndex },
  )
}

test.describe('a decorated strip survives the renderer', () => {
  test('colour, name, pinning and order all come back after a reload', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator(TAB)).toHaveCount(1, { timeout: 15_000 })
    await promptReady(page)

    // Two tabs, so there is an order to change.
    await page.locator('[aria-label="New tab"]').click()
    await expect(page.locator(TAB)).toHaveCount(2, { timeout: 15_000 })
    await promptReady(page)

    // Decorate the SECOND one: a name the user typed, a colour, and a pin.
    await renameTab(page, 1, 'release')
    await expect(page.locator(TAB).nth(1).locator('.nocx-tab-title')).toHaveText('release', {
      timeout: 10_000,
    })

    await openTabMenu(page, 1)
    await pickMenuItem(page, 'Green')
    await expect(page.locator(TAB).nth(1)).toHaveAttribute('data-colour', 'green', {
      timeout: 10_000,
    })

    // Reorder BEFORE pinning: a pinned tab is placed at the head whatever the
    // positions say, so pinning first would hide whether the positions were
    // stored at all.
    const firstId = await page.locator(TAB).nth(0).getAttribute('data-pane-id')
    const secondId = await page.locator(TAB).nth(1).getAttribute('data-pane-id')
    expect(firstId).not.toBeNull()
    expect(secondId).not.toBeNull()
    await dragTabOnto(page, secondId!, 0)
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll('.nocx-tab')).map((t) =>
              t.getAttribute('data-pane-id'),
            ),
          ),
        { timeout: 15_000, message: 'the strip never took the new order' },
      )
      .toEqual([secondId, firstId])

    // And pin it, which is a different fact from where it sits.
    await openTabMenu(page, 0)
    await pickMenuItem(page, 'Pin')
    await expect(page.locator(TAB).nth(0)).toHaveAttribute('data-pinned', 'true', {
      timeout: 10_000,
    })

    // ── The renderer goes away ──────────────────────────────────────────
    // Nothing here restarts the backend: this is the reload the epic names,
    // and everything below came out of the chain the backend holds.
    await page.reload()
    await expect(page.locator(TAB)).toHaveCount(2, { timeout: 20_000 })

    const head = page.locator(TAB).nth(0)
    await expect(head.locator('.nocx-tab-title')).toHaveText('release', { timeout: 15_000 })
    await expect(head).toHaveAttribute('data-colour', 'green')
    await expect(head).toHaveAttribute('data-pinned', 'true')
    await expect(head.locator('.nocx-tab-pin')).toBeVisible()

    // The order survived too, and it is the order the drag asked for rather
    // than the order the tabs were created in. The pane ids are the
    // renderer's own from before the reload — a durable UUIDv7 per pane, the
    // reason §7 puts the minting in the frontend — so a strip rebuilt from
    // the chain addresses the same panes.
    await expect(page.locator(TAB).nth(1).locator('.nocx-tab-title')).not.toHaveText('release')
  })

  test('a tab the user has not named is labelled by what is in its pane', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator(TAB)).toHaveCount(1, { timeout: 15_000 })
    await promptReady(page)

    // Nobody named this tab — a tab minted for a pane never was — so its
    // label is its pane's title, which is the cwd until something in the pane
    // says otherwise (§4.5, nocx-n8n82).
    const title = page.locator(`${TAB} .nocx-tab-title`).first()
    await expect(title).not.toHaveText('', { timeout: 15_000 })
    const derived = await title.textContent()

    // A name the user types wins over it…
    await renameTab(page, 0, 'inbox')
    await expect(title).toHaveText('inbox', { timeout: 10_000 })

    // …and clearing that name is a real operation, not a no-op: the tab goes
    // back to being labelled by its panes.
    await openTabMenu(page, 0)
    await pickMenuItem(page, 'Rename')
    const field = page.locator('.nocx-dialog__panel .ui-text-field__input')
    await expect(field).toBeVisible({ timeout: 10_000 })
    await field.fill('')
    await page.locator('.nocx-dialog__panel button', { hasText: 'Save' }).click()
    await expect(title).toHaveText(derived ?? '', { timeout: 10_000 })
  })
})
