// Screenshot capture: dynamic editor padding (nocx-4ff.18 follow-up)
// Demonstrates that .scrollback-inner padding tracks the live height of
// the .nocx-editor element.
//
// Usage:
//   nix-shell -p chromium --run "node spike/dom-scrollback/screenshots/capture-dynamic-padding.mjs"

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

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
  // Wait for shell + editor to boot
  await page.waitForTimeout(3000);

  const type = async (text) => {
    for (const ch of text) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(5);
    }
  };

  // ── (1) Single-line editor, newest block snug above it ──────────────
  console.log('Capturing: single-line editor with blocks...');
  // Generate a few blocks first so we have scrollback content.
  await type('echo "hello world"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  await type('echo "block two"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  // Verify dynamic padding is set on .scrollback-inner
  const padding1 = await page.evaluate(() => {
    const el = document.querySelector('.scrollback-inner');
    return el ? getComputedStyle(el).paddingBottom : 'no element';
  });
  console.log(`  Editor padding (single-line): ${padding1}`);

  await screenshot(page, 'dynpad-1-single-line-editor.png');

  // ── (2) Expand to 5-line command, verify blocks shift up ────────────
  console.log('Capturing: 5-line editor expanded...');
  // Click the textarea and type multi-line content to grow it.
  // Use Shift+Enter to insert newlines (Enter alone submits the command).
  await page.click('.nocx-editor-input');
  // Type 5 lines using Shift+Enter for newlines.
  for (let i = 1; i <= 5; i++) {
    await type(`line ${i} of a multiline command test`);
    if (i < 5) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
    }
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(500);

  const padding5 = await page.evaluate(() => {
    const el = document.querySelector('.scrollback-inner');
    return el ? getComputedStyle(el).paddingBottom : 'no element';
  });
  console.log(`  Editor padding (5-line): ${padding5}`);

  await screenshot(page, 'dynpad-2-five-line-editor.png');

  // ── (3) Collapse back to 1 line, verify gap shrinks ────────────────
  console.log('Capturing: collapsed back to single-line editor...');
  // Clear the textarea and type a single line.
  // Use Escape to clear the textarea (editor's Escape handler clears the value).
  await page.click('.nocx-editor-input');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await type('single line again');
  await page.waitForTimeout(500);

  const paddingCollapsed = await page.evaluate(() => {
    const el = document.querySelector('.scrollback-inner');
    return el ? getComputedStyle(el).paddingBottom : 'no element';
  });
  console.log(`  Editor padding (collapsed): ${paddingCollapsed}`);

  await screenshot(page, 'dynpad-3-collapsed-single-line.png');

  await browser.close();
  console.log(`\nDone. Screenshots saved to ${OUT}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
