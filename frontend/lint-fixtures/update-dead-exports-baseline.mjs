#!/usr/bin/env node
/**
 * Regenerate `lint-fixtures/dead-exports-baseline.json` from the current knip
 * output.
 *
 * Usage: npm run baseline:dead-exports-update   (from frontend/)
 *
 * This is a deliberate regeneration: the baseline must be explicitly updated
 * (run this command) rather than being a side effect of lint. Growth guard,
 * mirroring lint-fixtures/update-raw-controls-baseline.mjs: refuses to write
 * a baseline that contains a violation absent from the existing one. Only
 * pure shrink or no-change is allowed, so regeneration cannot silently
 * legitimize new dead exports. Removing entries (the fix for dead code) is
 * the one direction that never fails.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectKnipViolations, violationKey } from './check-dead-exports.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = resolve(__dirname, 'dead-exports-baseline.json')

// ─── Load existing baseline ────────────────────────────────────────────────
const oldBaseline = new Map()
if (existsSync(BASELINE_PATH)) {
  const data = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  for (const v of data.violations) {
    oldBaseline.set(violationKey(v), v)
  }
}

// ─── Collect current violations ────────────────────────────────────────────
console.log('Running knip to collect violations...')
let violations
try {
  ;({ violations } = collectKnipViolations())
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

// ─── Growth guard: every new violation must match an old baseline entry ────
const growth = violations.filter((v) => !oldBaseline.has(violationKey(v)))

if (growth.length > 0) {
  console.error(
    `REFUSING to update baseline: ${growth.length} violation(s) are not in the existing baseline.`,
  )
  for (const v of growth) {
    console.error(`  NEW: ${v.file}: ${v.kind === 'file' ? '(unused file)' : v.symbol}`)
  }
  console.error(
    'Fix the dead code first, or add the entries deliberately by hand if you know what you are doing.',
  )
  process.exit(1)
}

// ─── Write baseline ────────────────────────────────────────────────────────
const content = JSON.stringify(
  {
    '//': [
      'DO NOT EDIT MANUALLY. Regenerate with `npm run baseline:dead-exports-update`.',
      '',
      'Every entry is an unused file, export or exported type that knip reports',
      'from the entry points in knip.json. It may only shrink. A violation knip',
      'reports that is not listed here is a new violation and fails the',
      'pre-commit hook.',
    ],
    violations: violations,
  },
  null,
  2,
)

writeFileSync(BASELINE_PATH, content + '\n')

const shrunk = oldBaseline.size - violations.length
const change = shrunk > 0 ? ` (shrunk by ${shrunk})` : ''
console.log(`Baseline written: ${violations.length} violations.${change}`)
