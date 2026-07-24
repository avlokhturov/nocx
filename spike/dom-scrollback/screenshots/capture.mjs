// Screenshot capture script for nocx-4ff.18 follow-up.
// Uses system chromium via nix-shell because Playwright's bundled
// chromium can't run on NixOS (stub-ld issue).
//
// Usage:
//   nix-shell -p chromium --run "node spike/dom-scrollback/screenshots/capture.mjs"

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

// Find system chromium
function findChromium() {
  try {
    return execSync('which chromium', { encoding: 'utf8' }).trim();
  } catch {
    return 'chromium';
  }
}

async function screenshot(page, name) {
  const p = path.join(OUT, name);
  await page.screenshot({ path: p });
  console.log(`  ✓ ${name}`);
}

async function main() {
  const chromePath = findChromium();
  console.log(`Using chromium: ${chromePath}`);
  
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  
  const BASE = 'http://localhost:5174';
  await page.goto(BASE);
  // Wait for shell to start
  await page.waitForTimeout(3000);

  const type = async (text) => {
    for (const ch of text) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(5);
    }
  };

  // ── (1) Several blocks with output ──────────────────────────────────
  console.log('Capturing: blocks with output...');
  await type('echo "hello world"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  await type('ls -la /home/dev/repos/warpify');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await type('echo "line 1" && echo "line 2" && echo "line 3"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  await screenshot(page, 'p1-blocks-with-output.png');

  // ── (2) Zero-output command block ──────────────────────────────────
  console.log('Capturing: zero-output block...');
  await type('cd /tmp');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await type('cd /home/dev/repos/warpify');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await screenshot(page, 'p2-zero-output-block.png');

  // ── (3) Alt-screen running htop ────────────────────────────────────
  console.log('Capturing: alt-screen (htop)...');
  await type('htop');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  await screenshot(page, 'p3-alt-screen-htop.png');
  // Exit htop
  await page.keyboard.press('q');
  await page.waitForTimeout(500);

  // ── (4) Shadow variant comparison ──────────────────────────────────
  console.log('Capturing: shadow variants...');
  // With shadows (default)
  await type('echo "with shadow"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await screenshot(page, 'p4-with-shadow.png');
  
  // Without shadows
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.cmd-block')) {
      el.style.boxShadow = 'none';
    }
  });
  await type('echo "no shadow"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await screenshot(page, 'p4-no-shadow.png');

  await browser.close();
  console.log(`\nDone. Screenshots saved to ${OUT}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
