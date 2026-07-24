import { chromium } from 'playwright';
const CHROMIUM_PATH = '/nix/store/5prcsr1v91xai06jmpxxh3wh4c79h0s6-chromium-150.0.7871.181/bin/chromium';
const WSPORT = 37229;
const VITE_URL = 'http://localhost:5173';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (err) => console.log('PAGE_ERR:', err.message));

  await page.addInitScript((port) => {
    window.go = { main: { WailsApp: { GetWSPort: () => Promise.resolve(Number(port)) } } };
  }, String(WSPORT));

  await page.goto(`${VITE_URL}/spike.html`, { waitUntil: 'load' });

  // Wait for ready
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const s = await page.evaluate(() => document.getElementById('status')?.textContent || '');
    if (s.includes('ready')) { ready = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!ready) { console.log('NOT READY'); await browser.close(); return; }
  console.log('Ready.\n');

  await page.waitForTimeout(2000);

  // Run seq 1 5000 (smaller test to verify it works)
  console.log('Running seq 1 5000...');
  await page.keyboard.type('seq 1 5000\n', { delay: 15 });
  console.log('Waiting for completion...');

  // Wait up to 30s for frozen block
  let frozen = false;
  for (let i = 0; i < 30; i++) {
    const s = await page.evaluate(() => document.getElementById('perf-blocks')?.textContent || '');
    const m = s.match(/frozen: (\d+)/);
    if (m && parseInt(m[1]) >= 1) { frozen = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }

  const perf = await page.evaluate(() => {
    const s = (id) => document.getElementById(id)?.textContent || '';
    return {
      blocks: s('perf-blocks'),
      nodes: s('perf-nodes'),
      serialize: s('perf-serialize'),
      scroll: s('perf-scroll'),
    };
  });
  console.log('Perf:', JSON.stringify(perf, null, 2));

  // Check block content
  const blockText = await page.evaluate(() => {
    const b = document.querySelector('.cmd-output');
    return b?.textContent?.substring(0, 500) || '(none)';
  });
  console.log('Block output (first 300):', blockText.substring(0, 300));

  const lines = await page.evaluate(() => document.querySelectorAll('.term-line').length);
  console.log('Term lines:', lines);

  // Now seq 1 12000
  console.log('\nRunning seq 1 12000...');
  await page.keyboard.type('seq 1 12000\n', { delay: 15 });
  console.log('Waiting...');

  for (let i = 0; i < 45; i++) {
    const s = await page.evaluate(() => document.getElementById('perf-blocks')?.textContent || '');
    const m = s.match(/frozen: (\d+)/);
    if (m && parseInt(m[1]) >= 2) { frozen = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }

  const perf2 = await page.evaluate(() => {
    const s = (id) => document.getElementById(id)?.textContent || '';
    return {
      blocks: s('perf-blocks'),
      nodes: s('perf-nodes'),
      serialize: s('perf-serialize'),
      scroll: s('perf-scroll'),
    };
  });
  console.log('Perf 12k:', JSON.stringify(perf2, null, 2));

  const lines2 = await page.evaluate(() => document.querySelectorAll('.term-line').length);
  console.log('Term lines (12k):', lines2);

  await page.screenshot({ path: 'spike/dom-scrollback/screenshots/q5-10k-perf.png', fullPage: true });

  await browser.close();
}
main().catch(console.error);
