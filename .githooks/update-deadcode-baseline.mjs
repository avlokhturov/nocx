#!/usr/bin/env node
/**
 * Regenerate `.githooks/deadcode-baseline.json` from the current deadcode
 * output.
 *
 * Usage: node .githooks/update-deadcode-baseline.mjs   (from the repo root)
 *
 * This is a deliberate regeneration: the baseline must be explicitly updated
 * (run this command) rather than being a side effect of the gate. Growth
 * guard, mirroring lint-fixtures/update-raw-controls-baseline.mjs: refuses to
 * write a baseline that contains a violation absent from the existing one.
 * Only pure shrink or no-change is allowed, so regeneration cannot silently
 * legitimize new dead code. Removing entries (the fix for dead code) is the
 * one direction that never fails.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDeadcodeViolations, violationKey } from './check-deadcode.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = resolve(__dirname, 'deadcode-baseline.json')

// ─── Load existing baseline ────────────────────────────────────────────────
const oldBaseline = new Map()
if (existsSync(BASELINE_PATH)) {
  const data = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  for (const v of data.violations) {
    oldBaseline.set(violationKey(v), v)
  }
}

// ─── Collect current violations ────────────────────────────────────────────
console.log('Running deadcode to collect violations...')
let violations
try {
  violations = collectDeadcodeViolations()
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
    console.error(`  NEW: ${v.file}: ${v.func}`)
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
      'DO NOT EDIT MANUALLY. Regenerate with `node .githooks/update-deadcode-baseline.mjs`.',
      '',
      'Every entry is a Go function `deadcode ./...` reports unreachable from main().',
      'It may only shrink. A function deadcode reports that is not listed here is a',
      'new violation and fails the pre-commit hook.',
      '',
      'NOT machine-specific: the list is the UNION over darwin/arm64 and linux/amd64,',
      'analysed with CGO_ENABLED=0, so every machine computes the same set. Both',
      'halves of a build-tag-gated pair (secretservice_linux.go and its _other',
      'sibling) are therefore listed, and an entry never appears or vanishes because',
      'of who ran the gate — which is what made this unpassable on macOS while CI,',
      'which runs no deadcode at all, stayed silent (nocx-0odm).',
    ],
    violations: violations,
  },
  null,
  2,
)

writeFileSync(BASELINE_PATH, content + '\n')

const shrunk = oldBaseline.size - violations.length
const change = shrunk > 0 ? ` (shrunk by ${shrunk})` : ''
console.log(`Baseline written: ${violations.length} unreachable functions.${change}`)
