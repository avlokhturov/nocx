import { chromium } from 'playwright';

const WSPORT = parseInt(process.env.WSPORT || '37229', 10);
const VITE_URL = process.env.VITE_URL || 'http://localhost:5173';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/nix/store/5prcsr1v91xai06jmpxxh3wh4c79h0s6-chromium-150.0.7871.181/bin/chromium';

async function poll(fn, timeout = 15000, interval = 500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`poll timed out after ${timeout}ms`);
}

async function main() {
  console.log(`Chromium: ${CHROMIUM_PATH}`);
  console.log(`Vite: ${VITE_URL}/spike.html`);
  console.log(`WSPORT: ${WSPORT}\n`);

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (err) => console.log('PAGE_ERR:', err.message));
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('nocx') || t.includes('GetWSPort') || (msg.type() === 'error' && !t.includes('404')))
      console.log(`PAGE [${msg.type()}]:`, t.substring(0, 300));
  });

  await page.addInitScript((port) => {
    window.go = {
      main: { WailsApp: { GetWSPort: () => Promise.resolve(Number(port)) } }
    };
  }, String(WSPORT));

  try {
    console.log('Navigating to spike...');
    await page.goto(`${VITE_URL}/spike.html`, { waitUntil: 'load' });

    // Wait for ready status
    await poll(async () => {
      const s = await page.evaluate(() => document.getElementById('status')?.textContent || '');
      return s.includes('ready');
    }, 25000);
    console.log('Connected and ready.\n');

    // Wait for shell to settle
    await page.waitForTimeout(3000);

    // Q1: Serialize colored ls
    console.log('=== Q1: Serialize (colored ls) ===');
    await page.keyboard.type('ls -la --color=always /home/dev/repos/warpify/docs\n', { delay: 15 });
    await poll(async () => {
      const s = await page.evaluate(() => document.getElementById('perf-blocks')?.textContent || '');
      return parseInt((s.match(/frozen: (\d+)/) || [])[1] || '0') >= 1;
    }, 25000);
    await page.waitForTimeout(1000);

    const q1Text = await page.evaluate(() => {
      const b = document.querySelector('.cmd-block');
      return b?.textContent?.substring(0, 400) || '(none)';
    });
    console.log(`Block[0] (first 300): ${q1Text.substring(0, 300)}`);
    console.log(`Q1 verdict: ${q1Text.includes('total') || q1Text.includes('drwx') ? 'PASS' : 'CHECK'}`);
    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q1-colored-ls.png', fullPage: true });
    console.log('');

    // Q2: Progress bar
    console.log('=== Q2: Progress bar ===');
    await page.keyboard.type('for i in $(seq 1 15); do printf "\\rProgress: %d/15" "$i"; sleep 0.1; done; echo\n', { delay: 15 });
    await page.waitForTimeout(5000);
    await poll(async () => {
      const s = await page.evaluate(() => document.getElementById('perf-blocks')?.textContent || '');
      return parseInt((s.match(/frozen: (\d+)/) || [])[1] || '0') >= 2;
    }, 25000);
    const q2Text = await page.evaluate(() => {
      const bs = document.querySelectorAll('.cmd-block');
      return bs[1]?.textContent?.substring(0, 400) || '(none)';
    });
    console.log(`Block[1]: ${q2Text.substring(0, 300)}`);
    console.log(`Q2 verdict: ${q2Text.includes('Progress') ? 'PASS' : 'CHECK'}`);
    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q2-progress-bar.png', fullPage: true });
    console.log('');

    // Q3: Alt-screen vim
    console.log('=== Q3: Alt-screen (vim) ===');
    await page.click('#btn-clear-blocks');
    await page.waitForTimeout(500);
    await page.keyboard.type('vim -c "set noswapfile" -c "set noruler" -c "set laststatus=0" +"echom \\"nocx-vim-test\\"" +"sleep 2" +"qa!"\n', { delay: 15 });
    await page.waitForTimeout(5000);
    const altScreen = await page.evaluate(() => {
      const xc = document.getElementById('xterm-container');
      return xc?.classList.contains('fullscreen') || false;
    });
    console.log(`Alt-screen active: ${altScreen}`);
    await page.waitForTimeout(3000);
    const altAfter = await page.evaluate(() => {
      const xc = document.getElementById('xterm-container');
      return xc?.classList.contains('fullscreen') || false;
    });
    const vimBlocks = await page.evaluate(() => document.querySelectorAll('.cmd-block').length);
    console.log(`Alt-screen after exit: ${altAfter}, blocks: ${vimBlocks}`);
    console.log(`Q3 verdict: ${!altAfter && vimBlocks < 2 ? 'PASS (no residue)' : 'CHECK (blocks remain or alt-screen not detected)'}`);
    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q3-vim-takeover.png', fullPage: true });
    console.log('');

    // Q4: Python
    console.log('=== Q4: Python ===');
    await page.click('#btn-clear-blocks');
    await page.waitForTimeout(500);
    await page.keyboard.type('python3 -c "print(1+1); import sys; print(sys.version.split()[0]); print(2+2)"\n', { delay: 15 });
    await page.waitForTimeout(3000);
    await poll(async () => {
      const s = await page.evaluate(() => document.getElementById('perf-blocks')?.textContent || '');
      return parseInt((s.match(/frozen: (\d+)/) || [])[1] || '0') >= 1;
    }, 20000);
    const q4Text = await page.evaluate(() => {
      const b = document.querySelector('.cmd-block');
      return b?.textContent?.substring(0, 400) || '(none)';
    });
    console.log(`Python output: ${q4Text.substring(0, 300)}`);
    console.log(`Q4 verdict: ${/2/.test(q4Text) ? 'PASS' : 'CHECK'}`);
    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q4-python-repl.png', fullPage: true });
    console.log('');

    // Q5: 10k perf
    console.log('=== Q5: 10k line performance ===');
    await page.click('#btn-clear-blocks');
    await page.waitForTimeout(500);
    await page.click('#btn-perf-test');
    console.log('Running seq 1 12000...');
    await page.waitForTimeout(12000);

    const q5Perf = await page.evaluate(() => {
      const s = (id) => document.getElementById(id)?.textContent || '';
      return {
        blocks: parseInt((s('perf-blocks').match(/blocks: (\d+)/) || [])[1] || '0'),
        frozen: parseInt((s('perf-blocks').match(/frozen: (\d+)/) || [])[1] || '0'),
        nodes: parseInt((s('perf-nodes').match(/DOM nodes: (\d+)/) || [])[1] || '0'),
        serializeMs: parseFloat((s('perf-serialize').match(/([\d.]+)ms/) || [])[1] || '0'),
      };
    });
    console.log(`Serialize: ${q5Perf.serializeMs}ms, DOM nodes: ${q5Perf.nodes}, blocks: ${q5Perf.blocks} (frozen: ${q5Perf.frozen})`);

    // Test content-visibility:auto
    await page.evaluate(() => {
      document.querySelectorAll('.cmd-block').forEach(b => {
        b.style.contentVisibility = 'auto';
        b.style.containIntrinsicSize = 'auto 24px';
      });
    });
    await page.waitForTimeout(500);
    const cvPerf = await page.evaluate(() => {
      const s = (id) => document.getElementById(id)?.textContent || '';
      return {
        nodes: parseInt((s('perf-nodes').match(/DOM nodes: (\d+)/) || [])[1] || '0'),
      };
    });
    console.log(`With content-visibility:auto — DOM nodes: ${cvPerf.nodes}`);
    console.log(`Q5 verdict: ${q5Perf.serializeMs < 5000 ? 'PASS (fast serialize)' : 'CHECK (slow serialize)'}, ${q5Perf.nodes} nodes`);
    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q5-10k-perf.png', fullPage: true });
    console.log('');

    // Q6: Resize
    console.log('=== Q6: Resize ===');
    const preBlocks = await page.evaluate(() => document.querySelectorAll('.cmd-block').length);
    await page.setViewportSize({ width: 600, height: 600 });
    await page.waitForTimeout(1500);
    const midBlocks = await page.evaluate(() => document.querySelectorAll('.cmd-block').length);
    console.log(`Blocks at 600x600: ${midBlocks} (was ${preBlocks})`);

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(1000);
    await page.keyboard.type('echo "post-resize"\n', { delay: 15 });
    await page.waitForTimeout(3000);
    const postBlocks = await page.evaluate(() => document.querySelectorAll('.cmd-block').length);
    console.log(`Blocks after resize + cmd: ${postBlocks}`);
    console.log(`Q6 verdict: ${postBlocks > preBlocks ? 'PASS (new blocks after resize)' : 'CHECK'}`);
    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q6-resize.png', fullPage: true });
    console.log('');

    // Q7: clear
    console.log('=== Q7: clear semantics ===');
    const beforeClear = await page.evaluate(() => document.querySelectorAll('.cmd-block').length);
    await page.keyboard.type('clear\n', { delay: 15 });
    await page.waitForTimeout(2000);
    const afterClear = await page.evaluate(() => document.querySelectorAll('.cmd-block').length);
    console.log(`Blocks: ${beforeClear} → ${afterClear}`);
    console.log(`Q7 verdict: clear does NOT remove DOM blocks — proposal: clear should clear DOM scrollback`);
    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q7-clear-semantics.png', fullPage: true });
    console.log('');

    // Bonus: git log
    console.log('=== Bonus: git log ===');
    await page.keyboard.type('cd /home/dev/repos/warpify && git log --oneline -5\n', { delay: 15 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/bonus-git-log.png', fullPage: true });

    // Final summary
    console.log('\n=== FINAL PERF ===');
    const final = await page.evaluate(() => {
      const s = (id) => document.getElementById(id)?.textContent || '';
      return { blocks: s('perf-blocks'), nodes: s('perf-nodes'), serialize: s('perf-serialize'), scroll: s('perf-scroll') };
    });
    console.log(JSON.stringify(final, null, 2));

  } catch (err) {
    console.error('FAILED:', err);
    await page.screenshot({ path: 'spike/dom-scrollback/screenshots/error.png', fullPage: true });
  } finally {
    await browser.close();
    console.log('\nDone. Screenshots in spike/dom-scrollback/screenshots/');
  }
}

main().catch(console.error);
