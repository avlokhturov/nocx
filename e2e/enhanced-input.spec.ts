import { test, expect, promptReady } from './harness'

// nocx-4ff.4: verify that raw input routing works after an enhanced-input
// submit — the editor must stay hidden while a program runs, and typed keys
// must reach the PTY rather than the editor.

const INPUT = '.nocx-editor-input'

test.describe('enhanced input raw routing', () => {
  test('read command receives input after enhanced submit', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    await promptReady(page)

    // Read a line into x, then print got-<x>. Completed command output is
    // frozen into a DOM scrollback block even though live xterm output is a
    // WebGL canvas.
    await page.keyboard.type('read x; printf \'got-%s\\n\' "$x"')
    await page.keyboard.press('Enter')
    await expect(page.locator(INPUT)).not.toBeVisible({ timeout: 5000 })

    // The `read` builtin is now waiting for stdin. Typing must reach the running
    // program (RUNNING_RAW → editor hidden), not the editor.
    await page.keyboard.type('hello')
    await page.keyboard.press('Enter')

    // The completed block proves the input reached `read`, not the editor.
    await expect(page.locator('.cmd-block', { hasText: 'got-hello' }).first()).toBeVisible({
      timeout: 5000,
    })
  })

  test('Ctrl-C at a prompt does not trap input', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    await promptReady(page)

    // Type partial input then Ctrl-C to cancel.
    await page.keyboard.type('echo partial')
    await page.keyboard.press('Control+c')

    // What Ctrl-C must do, stated as the two things a USER can observe.
    //
    // This used to install a `blur` listener on the editor and wait for the
    // attribute it set, on the reasoning that the fresh prompt "briefly hides
    // (and blurs) the editor" — and an empty line alone would pass before the
    // shell had answered. The first half is an implementation detail the
    // product does not promise: `cancel` sends \x03 and clears the draft
    // locally (terminal-content.ts), and nothing guarantees a hide/blur cycle
    // around the shell's new prompt. It held on a fast machine and stopped
    // holding at the runner's 4 vCPU, which is how this failed on both
    // engines in CI while passing locally.
    //
    // The concern behind it was sound, so it is answered rather than dropped
    // — by assertions on the product's contract instead of on a DOM event:
    await promptReady(page)
    await expect(page.locator(INPUT)).toHaveText('', { timeout: 5000 })

    // (1) Input is not trapped: a command typed after Ctrl-C runs. Reaching a
    // completed output block proves the keystrokes went to the shell, the
    // shell was at a prompt to receive them, and the result came back.
    //
    // SUBMITTED UNDER A RETRY, and that is the whole difficulty of this test.
    // Nothing in the DOM marks the instant the shell finishes processing \x03:
    // the editor never lost focus and `cancel()` cleared the draft locally
    // (terminal-content.ts), so promptReady and an empty line are both already
    // true while the shell has not yet answered. Submitting into that gap
    // reaches a shell that is not at a prompt and the keystrokes are simply
    // gone — measured, as five session-data events for the whole test where a
    // healthy one has fifteen.
    //
    // The previous version bridged the gap by waiting for a `blur` event, an
    // implementation detail the product does not promise; it held on a fast
    // machine and stopped holding at the runner's 4 vCPU. Retrying asserts the
    // contract instead of the timing: if the first Enter raced the interrupt
    // it produced nothing and the next attempt lands, and if it did land the
    // poll sees the block and stops. A genuinely trapped input still fails,
    // just at the bound rather than on the first try.
    const suffix = Date.now().toString(36)
    const marker = `RW-${suffix}`
    const block = page.locator('.cmd-block', { hasText: marker }).first()
    const submit = async () => {
      await page.keyboard.type(`printf 'RW-%s\\n' '${suffix}'`)
      await page.keyboard.press('Enter')
      return block
        .waitFor({ state: 'visible', timeout: 4_000 })
        .then(() => true)
        .catch(() => false)
    }
    await expect.poll(submit, { timeout: 20_000, intervals: [250] }).toBe(true)

    // (2) And Ctrl-C CANCELLED rather than submitted — the abandoned draft
    // never ran. Checked after (1) rather than before, and that ordering is
    // what makes it a real check: a completed block for a later command
    // exists, so the transcript is populated and "no block says partial" is
    // an observation rather than a race with an empty transcript. This is
    // new; the blur trick never asserted it.
    await expect(page.locator('.cmd-block', { hasText: 'echo partial' })).toHaveCount(0)
  })

  test('multiple submits in succession all route raw', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nocx-tab')).toHaveCount(1)

    await promptReady(page)

    // Run several commands back-to-back — each submit must leave the state
    // machine in RUNNING_RAW (owned:false) so the next prompt returns via
    // markers, and each paste must NOT leak bracketed-paste wrappers into the
    // command. Each command prints a marker assembled by the shell so it does
    // not occur verbatim in the command text.
    for (let i = 0; i < 3; i++) {
      const marker = `MS-${i}`
      await page.keyboard.type(`printf 'MS-%s\\n' ${i}`)
      await page.keyboard.press('Enter')
      // Wait for this command's completed output before sending the next.
      // Without this gate the keystrokes for iteration i+1 can arrive
      // while the shell is still executing iteration i — the editor
      // input buffer and PTY stdin are not synchronised, and rapid
      // submission races.  A duration wait is not correct here either:
      // the only contract that matters is that each command has
      // finished when we send the next.  expect() polls, so this
      // converges as fast as the shell does.
      await expect(page.locator('.cmd-block', { hasText: marker }).first()).toBeVisible({
        timeout: 5000,
      })
      await promptReady(page)
    }
  })
})
