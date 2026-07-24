// DOM Scrollback Spike — Playwright validation script (v2)
// Run: CHROMIUM_PATH=$(nix-shell -p chromium --run "which chromium") WSPORT=<N> VITE_URL=http://localhost:5173 npx tsx spike/dom-scrollback/validate.ts

import { chromium } from 'playwright'

const WSPORT = parseInt(process.env.WSPORT || '37229', 10)
const VITE_URL = process.env.VITE_URL || 'http://localhost:5173'
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/nix/store/5prcsr1v91xai06jmpxxh3wh4c79h0s6-chromium-150.0.7871.181/bin/chromium'

async function getPerf(page: any) {
  return page.evaluate(() => {
    const s = (id: string) => document.getElementById(id)?.textContent || ''
    return {
      blocks: parseInt(s('perf-blocks').match(/blocks: (\d+)/)?.[1] || '0'),
      frozen: parseInt(s('perf-blocks').match(/frozen: (\d+)/)?.[1] || '0'),
      nodes: parseInt(s('perf-nodes').match(/DOM nodes: (\d+)/)?.[1] || '0'),
      serializeMs: parseFloat(s('perf-serialize').match(/([\d.]+)ms/)?.[1] || '0'),
    }
  })
}

async function sendKeys(page: any, text: string) { await page.keyboard.type(text, { delay: 15 }) }
async function sendEnter(page: any) { await page.keyboard.press('Enter') }

async function poll(fn: () => Promise<boolean>, timeout = 15000, interval = 500): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`poll timed out after ${timeout}ms`)
}

async function waitReady(page: any, timeout = 15000) {
  await poll(async () => {
    const s = await page.evaluate(() => document.getElementById('status')?.textContent || '')
    return s.includes('ready')
  }, timeout)
}

async function waitFrozenBlocks(page: any, min: number, timeout = 15000) {
  await poll(async () => {
    const s = await page.evaluate(() => document.getElementById('perf-blocks')?.textContent || '')
    const m = s.match(/frozen: (\d+)/)
    return m ? parseInt(m[1]) >= min : false
  }, timeout)
}

async function countBlocks(page: any) {
  return page.evaluate(() => document.querySelectorAll('.cmd-block').length)
}

async function getBlockText(page: any, i: number) {
  return page.evaluate((idx) => {
    const bs = document.querySelectorAll('.cmd-block')
    return bs[idx]?.textContent?.substring(0, 500) || '(none)'
  }, i)
}

async function isAltScreen(page: any) {
  return page.evaluate(() => {
    const xc = document.getElementById('xterm-container')
    return xc?.classList.contains('fullscreen') || false
  })
}

async function main() {
  console.log(`Chromium: ${CHROMIUM_PATH}`)
  console.log(`Vite: ${VITE_URL}/spike.html`)
  console.log(`WSPORT: ${WSPORT}\n`)

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  })

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  page.on('pageerror', (err) => console.log('PAGE_ERR:', err.message))

  await page.addInitScript((port) => {
    (window as any).go = {
      main: { WailsApp: { GetWSPort: () => Promise.resolve(Number(port)) } }
    }
  }, String(WSPORT))

  try {
    console.log('Navigating to spike...')
    await page.goto(`${VITE_URL}/spike.html`, { waitUntil: 'load' })
    await waitReady(page, 20000)
    console.log('Connected and ready.\n')

    // Wait for initial shell to settle
    await page.waitForTimeout(2000)

    // ═══════════════════════════════════════════════════════════════════
    // Q1: Serialize xterm buffer to DOM block (colored ls)
    // ═══════════════════════════════════════════════════════════════════
    console.log('=== Q1: Serialize (colored ls) ===')
    await sendKeys(page, 'ls -la --color=always /home/dev/repos/warpify/docs')
    await sendEnter(page)

    await waitFrozenBlocks(page, 1, 20000)
    await page.waitForTimeout(1000)

    const q1Text = await getBlockText(page, 0)
    console.log(`Block[0] (first 300): ${q1Text.substring(0, 300)}`)

    const hasColors = q1Text.includes('drwx') || q1Text.includes('total')
    console.log(`Q1 verdict: ${hasColors ? 'PASS' : 'CHECK'} — output serialized to DOM block\n`)

    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q1-colored-ls.png', fullPage: true })

    // ═══════════════════════════════════════════════════════════════════
    // Q2: Live region + progress bar → freeze
    // ═══════════════════════════════════════════════════════════════════
    console.log('=== Q2: Progress bar live region ===')
    await sendKeys(page, 'for i in $(seq 1 15); do printf "\\rProgress: %d/15" "$i"; sleep 0.1; done; echo')
    await sendEnter(page)

    await page.waitForTimeout(4000)
    await waitFrozenBlocks(page, 2, 20000)

    const q2Text = await getBlockText(page, 1)
    const hasProgress = q2Text.includes('Progress')
    console.log(`Q2 verdict: ${hasProgress ? 'PASS' : 'CHECK'} — progress captured in frozen block\n`)

    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q2-progress-bar.png', fullPage: true })

    // ═══════════════════════════════════════════════════════════════════
    // Q3: Alt-screen (vim) takeover + no residue
    // ═══════════════════════════════════════════════════════════════════
    console.log('=== Q3: Alt-screen (vim) ===')
    await page.click('#btn-clear-blocks')
    await page.waitForTimeout(500)

    const beforeVimBlocks = await countBlocks(page)
    console.log(`Blocks before vim: ${beforeVimBlocks}`)

    await sendKeys(page, 'vim -c "set noswapfile" -c "set noruler" -c "set laststatus=0" +"echom \\"nocx-vim-test\\"" +"sleep 2" +"qa!"')
    await sendEnter(page)
    await page.waitForTimeout(5000)

    const altScreenActive = await isAltScreen(page)
    console.log(`Alt-screen active: ${altScreenActive}`)

    // Wait for vim to exit
    await page.waitForTimeout(3000)
    const altScreenAfter = await isAltScreen(page)
    const vimBlocks = await countBlocks(page)
    console.log(`Alt-screen after exit: ${altScreenAfter}`)
    console.log(`DOM blocks after vim: ${vimBlocks}`)
    console.log(`Q3 verdict: ${!altScreenAfter && vimBlocks < 2 ? 'PASS' : 'CHECK'} — alt-screen takeover clean\n`)

    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q3-vim-takeover.png', fullPage: true })

    // ═══════════════════════════════════════════════════════════════════
    // Q4: Python REPL
    // ═══════════════════════════════════════════════════════════════════
    console.log('=== Q4: Python REPL ===')
    await page.click('#btn-clear-blocks')
    await page.waitForTimeout(500)

    await sendKeys(page, 'python3 -c "print(1+1); import sys; print(sys.version.split()[0]); print(2+2)"')
    await sendEnter(page)
    await page.waitForTimeout(3000)
    await waitFrozenBlocks(page, 1, 20000)

    const q4Text = await getBlockText(page, 0)
    const hasPyOut = /2|3\.\d/.test(q4Text)
    console.log(`Python output: ${q4Text.substring(0, 300)}`)
    console.log(`Q4 verdict: ${hasPyOut ? 'PASS' : 'CHECK'} — Python output captured\n`)

    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q4-python-repl.png', fullPage: true })

    // ═══════════════════════════════════════════════════════════════════
    // Q5: 10k+ line performance
    // ═══════════════════════════════════════════════════════════════════
    console.log('=== Q5: 10k+ line performance ===')
    await page.click('#btn-clear-blocks')
    await page.waitForTimeout(500)

    await page.click('#btn-perf-test')
    console.log('Running seq 1 12000...')

    // Wait for the huge output
    await page.waitForTimeout(10000)

    const q5Perf = await getPerf(page)
    console.log(`Serialize: ${q5Perf.serializeMs}ms for ${q5Perf.blocks} blocks`)
    console.log(`DOM nodes: ${q5Perf.nodes}`)

    // Scroll perf
    const scrollStart = performance.now()
    await page.evaluate(() => {
      const a = document.getElementById('scrollback-area')
      if (a) a.scrollTo({ top: 0, behavior: 'instant' })
    })
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const a = document.getElementById('scrollback-area')
      if (a) a.scrollTo({ top: a.scrollHeight, behavior: 'instant' })
    })
    const scrollMs = (performance.now() - scrollStart).toFixed(1)
    console.log(`Scroll full: ${scrollMs}ms`)

    // Test content-visibility:auto
    console.log('Applying content-visibility:auto...')
    await page.evaluate(() => {
      document.querySelectorAll('.cmd-block').forEach(b => {
        (b as HTMLElement).style.contentVisibility = 'auto'
        ;(b as HTMLElement).style.containIntrinsicSize = 'auto 24px'
      })
    })
    await page.waitForTimeout(500)

    const cvStart = performance.now()
    await page.evaluate(() => {
      const a = document.getElementById('scrollback-area')
      if (a) a.scrollTo({ top: 0, behavior: 'instant' })
    })
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const a = document.getElementById('scrollback-area')
      if (a) a.scrollTo({ top: a.scrollHeight, behavior: 'instant' })
    })
    const cvMs = (performance.now() - cvStart).toFixed(1)
    console.log(`Scroll with c-v:auto: ${cvMs}ms`)
    console.log(`Q5 verdict: serialize ${q5Perf.serializeMs}ms, ${q5Perf.nodes} nodes — ${q5Perf.serializeMs < 5000 ? 'PASS (acceptable)' : 'CHECK (needs optimization)'}\n`)

    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q5-10k-perf.png', fullPage: true })

    // ═══════════════════════════════════════════════════════════════════
    // Q6: Resize behavior
    // ═══════════════════════════════════════════════════════════════════
    console.log('=== Q6: Resize ===')
    const preResizeBlocks = await countBlocks(page)
    await page.setViewportSize({ width: 600, height: 600 })
    await page.waitForTimeout(1500)

    const midResizeBlocks = await countBlocks(page)
    console.log(`Blocks persist after shrink: ${preResizeBlocks} → ${midResizeBlocks}`)

    await sendKeys(page, 'echo "post-resize command"')
    await sendEnter(page)
    await page.waitForTimeout(3000)
    await waitFrozenBlocks(page, q5Perf.frozen + 1, 20000)

    // Restore
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.waitForTimeout(1000)
    const finalBlocks = await countBlocks(page)
    console.log(`Blocks after restore + command: ${finalBlocks}`)
    console.log(`Q6 verdict: ${finalBlocks > preResizeBlocks ? 'PASS' : 'CHECK'} — resize preserves blocks + live region works\n`)

    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q6-resize.png', fullPage: true })

    // ═══════════════════════════════════════════════════════════════════
    // Q7: clear semantics
    // ═══════════════════════════════════════════════════════════════════
    console.log('=== Q7: clear semantics ===')
    // Add specific blocks first
    await sendKeys(page, 'echo "CLEAR_TEST_LINE_1"')
    await sendEnter(page)
    await page.waitForTimeout(2000)
    await sendKeys(page, 'echo "CLEAR_TEST_LINE_2"')
    await sendEnter(page)
    await page.waitForTimeout(2000)

    const beforeClearBlocks = await countBlocks(page)
    console.log(`Blocks before clear: ${beforeClearBlocks}`)

    await sendKeys(page, 'clear')
    await sendEnter(page)
    await page.waitForTimeout(3000)

    const afterClearBlocks = await countBlocks(page)
    console.log(`Blocks after clear: ${afterClearBlocks}`)
    console.log(`Q7 verdict: ${afterClearBlocks >= beforeClearBlocks ? 'CLEAR does NOT remove DOM blocks (as expected)' : 'Blocks removed'}`)
    console.log('  Proposal: clear should clear the DOM scrollback too (or have a separate "clear scrollback" action)\n')

    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q7-clear-semantics.png', fullPage: true })

    // ═══════════════════════════════════════════════════════════════════
    // Bonus: git log with colors
    // ═══════════════════════════════════════════════════════════════════
    console.log('=== Bonus: git log ===')
    await sendKeys(page, 'cd /home/dev/repos/warpify && git log --oneline -5')
    await sendEnter(page)
    await page.waitForTimeout(3000)

    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/bonus-git-log.png', fullPage: true })

    // Final perf summary
    const finalPerf = await getPerf(page)
    console.log('\n=== FINAL PERF ===')
    console.log(JSON.stringify(finalPerf, null, 2))

  } catch (err) {
    console.error('FAILED:', err)
    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/error.png', fullPage: true })
  } finally {
    await browser.close()
    console.log('\nDone. Screenshots in spike/dom-scrollback/screenshots/')
  }
}

main().catch(console.error)
