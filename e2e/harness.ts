import { test as base, expect as baseExpect, type Page } from '@playwright/test'

export { expect } from '@playwright/test'
export type { Page } from '@playwright/test'

/** Wait until the prompt editor owns input and typing can safely begin. */
export async function promptReady(page: Page): Promise<void> {
  const input = page.locator('.nocx-editor-input')
  await baseExpect(input).toBeVisible({ timeout: 10_000 })
  await baseExpect(input).toBeFocused({ timeout: 10_000 })
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
