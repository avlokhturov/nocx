import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, promptReady } from './harness'

const TAB = '.nocx-tab'
const ACTIVITY = '.nocx-tab-indicator[data-activity="true"]'

// A full-screen TUI repaints constantly in the alternate buffer, and those
// repaints deliberately do not light the indicator (nocx-5mf). A bell is the
// program explicitly asking for attention, so it must light it even there —
// that is the whole escape hatch, and it is what tells you Claude Code wants
// you back. If this fails, a background agent is silent and the feature is
// useless in the case it was built for.
test('a bell lights the indicator from inside the alternate buffer', async ({ page }) => {
  // The shell blocks on THIS file, and the test creates it only once the tab
  // is demonstrably in the background (nocx-z9s9.15).
  const gate = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nocx-e2e-bell-')), 'go')

  try {
    await page.goto('/')
    await expect(page.locator(TAB)).toHaveCount(1)

    // The precondition this test was missing, and the one that actually broke
    // it on CI. Having a `.nocx-tab` says a tab exists, not that the editor
    // owns the keyboard — so on a slow runner the keystrokes below were typed
    // into nothing, the shell never received `printf '\033[?1049h'`, and the
    // pane stayed `live-idle` through the whole 5s budget. The failure looked
    // like a broken alternate-screen transition and was a lost first character.
    //
    // It also explains the finding recorded against this bead: that swapping
    // the old `sleep 3` for a wait-loop made the alt screen stop registering
    // EVERY run, which read as a renderer defect. Both spellings were racing
    // the same missing wait; the loop is simply the longer line, so it lost
    // more often. Nothing is wrong with a compound `while` command.
    await promptReady(page)

    // Enter the alternate screen, block until the test opens the gate, ring
    // the bell, then block forever on `cat` so nothing races a deadline.
    //
    // The ordering that matters — the bell fires AFTER the tab is backgrounded
    // — used to be bought with `sleep 3`, whose clock starts at Enter rather
    // than at the moment the second tab exists. That is a bet on how long
    // opening a tab takes, and on a cold runner it is lost (the same defect
    // nocx-z9s9.14 fixed in activity.spec.ts). The gate makes it a fact.
    await page.keyboard.type(
      `printf '\\033[?1049h'; while [ ! -e ${gate} ]; do sleep 0.1; done; printf '\\a'; cat`,
    )
    await page.keyboard.press('Enter')

    // Asked of the PANE, not of `#app`. `#app.alt-screen` is gone: it existed
    // to empty the window chrome so a viewport-sized fullscreen xterm would not
    // paint through it, and nocx-6w4z moved the fullscreen region inside the
    // pane precisely so the chrome could stay. The class went with it, and this
    // wait silently became a 5s timeout on a class nothing sets any more
    // (nocx-42lb). `live-fullscreen` is what `enterFullscreen()` writes, on the
    // alt-screen path, so it states the same condition against the code that
    // survived.
    await expect(page.locator('.pane.active .xterm-live-container')).toHaveClass(
      /live-fullscreen/,
      { timeout: 10_000 },
    )

    await page.keyboard.press('Meta+t')
    await expect(page.locator(TAB)).toHaveCount(2)
    await expect(page.locator(TAB).first()).toHaveAttribute('aria-selected', 'false')

    // Backgrounded, and only now may the bell ring. Nothing before this line
    // can have lit the indicator, which is the property the test is about.
    //
    // One bell is enough, unlike activity.spec's repeating echo: that one has
    // to out-wait the 400ms resize-echo suppression a new tab triggers, and the
    // bell does not go through it — onBell calls requestAttention()
    // unconditionally (terminal-content.ts:1899). Suppressing a bell is exactly
    // what the escape hatch forbids.
    fs.writeFileSync(gate, '')

    await expect(page.locator(TAB).first().locator(ACTIVITY)).toBeAttached({ timeout: 10_000 })
  } finally {
    fs.rmSync(path.dirname(gate), { recursive: true, force: true })
  }
})
