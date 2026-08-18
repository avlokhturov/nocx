// TEMPORARY diagnostic spec — captures screenshots + geometry at key moments
// around Enter, during a SLOW command, and at freeze. DELETE AFTER USE.
import { test, expect, type Page } from './harness'
import { promptReady } from './harness'
import { mkdirSync } from 'node:fs'

declare global {
  // eslint-disable-next-line no-var
  var __frames: unknown[]
  // eslint-disable-next-line no-var
  var __arm: () => void
}

async function shot(page: Page, label: string): Promise<void> {
  mkdirSync('/tmp/jitter-shots', { recursive: true })
  await page.screenshot({ path: `/tmp/jitter-shots/${label}.png` })
}

test('capture geometry + shots around a slow command', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.nocx-tab')).toHaveCount(1)
  await promptReady(page)

  await page.evaluate(() => {
    const rec: unknown[] = []
    window.__frames = rec
    const snap = (label: string): void => {
      const area = document.querySelector<HTMLElement>('.pane.active .scrollback-area')
      const live = document.querySelector<HTMLElement>('.pane.active .xterm-live-container')
      const editor = document.querySelector<HTMLElement>('.pane.active .nocx-editor')
      const blocks = Array.from(document.querySelectorAll<HTMLElement>('.pane.active .cmd-block'))
      const areaRect = area?.getBoundingClientRect()
      rec.push({
        label,
        t: Math.round(performance.now()),
        scrollTop: area?.scrollTop ?? -1,
        scrollHeight: area?.scrollHeight ?? -1,
        clientHeight: area?.clientHeight ?? -1,
        liveTopInArea: live
          ? Math.round(live.getBoundingClientRect().top - (areaRect?.top ?? 0))
          : -1,
        liveRect: live ? Math.round(live.getBoundingClientRect().height) : -1,
        liveInline: live?.style.height ?? '',
        editorDisplay: editor?.style.display ?? '',
        blockTops: blocks.map((b) =>
          Math.round(b.getBoundingClientRect().top - (areaRect?.top ?? 0)),
        ),
        blockHeights: blocks.map((b) => Math.round(b.getBoundingClientRect().height)),
        innerTransform:
          document.querySelector<HTMLElement>('.pane.active .xterm-inner')?.style.transform ?? '',
      })
    }
    const raf = window.requestAnimationFrame.bind(window)
    let armed = false
    window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      return raf(() => {
        if (armed) snap('frame')
        cb(0)
      })
    }
    window.__arm = () => {
      armed = true
      snap('t0-beforeEnter')
    }
  })

  await shot(page, '0-before')
  await page.keyboard.type("sleep 0.6; printf 'line1\\nline2\\nline3\\n'")
  await shot(page, '1-typed-before-enter')

  await page.evaluate(() => (window as unknown as { __arm: () => void }).__arm())
  await page.keyboard.press('Enter')

  // catch the running phase mid-command
  await page.waitForTimeout(250)
  await shot(page, '2-running-mid')
  await page.waitForTimeout(400)
  await shot(page, '3-late-running')

  await expect(page.locator('.cmd-block', { hasText: 'line3' }).first()).toBeVisible({
    timeout: 5000,
  })
  await shot(page, '4-freeze')
  await page.waitForTimeout(400)
  await shot(page, '5-settled')

  const frames = await page.evaluate(() => (window as unknown as { __frames: unknown[] }).__frames)
  // eslint-disable-next-line no-console
  console.log('JITTER-FRAMES ' + JSON.stringify(frames, null, 1))
})
