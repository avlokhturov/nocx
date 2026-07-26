import { test as base, expect as baseExpect, type Page } from '@playwright/test'

export { expect } from '@playwright/test'
export type { Page } from '@playwright/test'

/**
 * Wait until the app is at a prompt that the editor owns — the only state in
 * which typing lands in the editor.
 *
 * A non-empty tab title is NOT that state, and using it as the gate is what
 * made this suite flaky. The title fills in when the session opens and reports
 * its cwd; ownership arrives later, when the shell's prompt markers drive the
 * input-state machine to owned=true and editor.show() takes focus. Between the
 * two, keystrokes go somewhere else and the command never runs.
 *
 * Measured, not inferred: the trace of CI run 30217202549 puts the test's first
 * action at t=73385ms and `input-state PROMPT_READY owned=true` at t=73424ms.
 * On a fast machine the gap closes before the test arrives, which is why this
 * only ever failed on macos-latest — and why it failed on a *different* test
 * each run (30217202549, 30217654133, 30217919912), whichever one happened to
 * lose the race.
 *
 * Focus is the right signal because it is the observable consequence of the
 * transition, and it is what the typing actually depends on.
 */
export async function promptReady(page: Page): Promise<void> {
  await baseExpect(page.locator('.tab-title').first()).not.toHaveText('', { timeout: 10_000 })
  await baseExpect
    .poll(() => page.evaluate(() => document.activeElement?.className ?? ''), { timeout: 10_000 })
    .toContain('nocx-editor-input')
}

// Shared e2e harness. When the suite runs against the headless
// vite + devharness shim (NOCX_WS_PORT set) instead of `wails dev`, inject the
// Wails GetWSPort binding the frontend expects before any app code runs. Under
// `wails dev` the real binding is present and NOCX_WS_PORT is unset, so this is
// a no-op — the same specs run unchanged in CI.
export const test = base.extend({
  page: async ({ page }, use) => {
    const port = process.env.NOCX_WS_PORT
    const token = process.env.NOCX_WS_TOKEN
    if (port) {
      if (!token) {
        throw new Error(
          'NOCX_WS_PORT set but NOCX_WS_TOKEN is missing; ' +
            'the token is the auth gate and an empty string is rejected. ' +
            'Export both or use `wails dev`.',
        )
      }
      await page.addInitScript(
        (opts: { p: string; t: string }) => {
          ;(window as unknown as { go: unknown }).go = {
            main: {
              WailsApp: {
                GetWSPort: () => Promise.resolve(Number(opts.p)),
                GetWSToken: () => Promise.resolve(opts.t),
                CheckForUpdate: () => Promise.resolve(null),
                ReportHealthy: () => Promise.resolve(),
                ApplyUpdate: () => Promise.resolve(),
              },
            },
          }
        },
        { p: port, t: token },
      )
    }
    await use(page)
  },
})
