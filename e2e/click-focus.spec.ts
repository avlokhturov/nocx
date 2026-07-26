import { test, expect } from './harness'

// Regression guard for the shared half of nocx-d1f: with one tab, clicking the
// window left the terminal unable to take input.
//
// Scope, stated honestly. Two fixes closed that bug:
//   - 2c02a46 stopped --wails-draggable leaking onto the pane, so Wails no
//     longer swallowed the mousedown;
//   - 25de485 made the ResizeObserver repaint after clearing the texture atlas.
// Neither is provable from here. --wails-draggable is an inert custom property
// in Chromium — only the native WKWebView reads it — and an e2e attempt at the
// atlas half passed just as happily with the fix reverted, so it was deleted
// rather than kept as a guard that guards nothing (see nocx-bq7).
//
// What this file does prove is that the path they share — click, focus,
// keystroke, PTY, response — is unbroken. That is worth locking on its own: it
// is the path every one of those bugs travelled through.
//
// Post nocx-4ff the editor owns input at every prompt (ADR-0004). The focus
// target is therefore .nocx-editor-input (the CommandEditor textarea), not
// .xterm-helper-textarea (the raw terminal grid). The path itself is identical.

const PANE = '.pane.active'
const INPUT = '.nocx-editor-input'

test('a click into the pane leaves the terminal taking keystrokes', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tab')).toHaveCount(1)
  // The editor appears only after shell integration marks the prompt ready.
  await expect(page.locator(INPUT)).toBeVisible({ timeout: 10_000 })

  // Move focus off the editor first. Without this the assertion is vacuous:
  // the tab is focused on load, so a click that changed nothing would pass.
  // Focus an outside control rather than calling blur(): a late prompt-state
  // transition legitimately focuses the editor and would race a bare blur.
  await page.locator('.tab-add').focus()
  await expect(page.locator('.tab-add')).toBeFocused()

  // Click near the bottom of the pane where the editor lives.  The centre
  // of the pane lands on the xterm area and its hidden textarea steals focus;
  // the focus-bounce handler bails when focus is already inside the xterm
  // container, so it never redirects — this exercises the editor's own
  // click-to-focus handler instead of the bounce path.  That path is itself
  // the subject of a separate fix: the bounce handler needs a mousedown
  // listener that focuses the editor when visible regardless of where focus
  // lands inside the pane.
  const box = await page.locator(PANE).boundingBox()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 30)

  await expect(page.locator(INPUT)).toBeFocused()

  // Emit a value that is not present verbatim in the command text. Completed
  // command output is frozen into a DOM scrollback block, so observing it
  // proves the click-to-keystroke-to-PTY round trip without racing the shell's
  // prompt title update.
  const marker = 'NOCX-D1F-CLICK'
  await page.keyboard.type("printf 'NOCX-D1F-%s\\n' CLICK")
  await page.keyboard.press('Enter')
  await expect(page.locator('.cmd-block', { hasText: marker }).first()).toBeVisible({
    timeout: 5000,
  })
})
