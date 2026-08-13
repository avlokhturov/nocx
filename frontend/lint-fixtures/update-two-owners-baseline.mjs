#!/usr/bin/env node
/**
 * Regenerate `lint-fixtures/two-owners-baseline.json` from the current tree.
 *
 * Usage: npm run baseline:two-owners-update   (from frontend/)
 *
 * Deliberate regeneration, never a side effect of lint. Growth guard,
 * mirroring update-dead-exports-baseline.mjs: refuses to write a baseline
 * that contains a violation absent from the existing one. Only pure shrink or
 * no-change is allowed, so regeneration cannot silently legitimize a new
 * render-site fallback. Removing entries (the fix for a fallback) is the one
 * direction that never fails.
 *
 * Reasons survive regeneration: each entry's `reason` is copied forward by
 * key, so a hand-written justification is never lost to a re-run. A reason
 * only disappears when its entry shrinks away.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanTree, violationKey } from './check-two-owners.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(__dirname, '..')
const BASELINE_PATH = resolve(__dirname, 'two-owners-baseline.json')

// ─── Load existing baseline ────────────────────────────────────────────────
const oldBaseline = new Map()
if (existsSync(BASELINE_PATH)) {
  const data = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  for (const v of data.violations) {
    oldBaseline.set(violationKey(v), v)
  }
}

// ─── Collect current violations ────────────────────────────────────────────
const violations = scanTree(resolve(FRONTEND_DIR, 'src'), FRONTEND_DIR)

// ─── Growth guard: every new violation must match an old baseline entry ────
const growth = violations.filter((v) => !oldBaseline.has(violationKey(v)))

if (growth.length > 0) {
  console.error(
    `REFUSING to update baseline: ${growth.length} violation(s) are not in the existing baseline.`,
  )
  for (const v of growth) {
    console.error(
      v.prop === 'PARSE'
        ? `  NEW: ${v.file}: parse error — ${v.fallback}`
        : `  NEW: ${v.file}:${v.line} ${v.prop}={${v.lhs} ${v.operator} ${v.fallback}}`,
    )
  }
  console.error(
    'Remove the render-site fallback first (or the parse error), or add the entry',
    'deliberately by hand with a reason if you know what you are doing.',
  )
  process.exit(1)
}

// ─── Write baseline (one entry per key; reasons copied from the old file) ──
const byKey = new Map()
for (const v of violations) {
  const key = violationKey(v)
  if (byKey.has(key)) continue
  byKey.set(key, { ...v, reason: oldBaseline.get(key)?.reason ?? '' })
}
const entries = [...byKey.values()].sort((a, b) =>
  a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
)

const content = JSON.stringify(
  {
    '//': [
      'DO NOT EDIT MANUALLY. Regenerate with `npm run baseline:two-owners-update`.',
      '',
      'Every entry is a value-bearing JSX prop (value/checked/selected/defaultValue)',
      'whose expression is `lhs || literal` or `lhs ?? literal` — a default invented',
      'at the render site, which by construction no validator or model can see',
      '(nocx-a88r: the port input painted 22 while the validator judged an empty',
      'draft). The baseline may only shrink; a violation it does not list is new and',
      'fails the pre-commit hook.',
      '',
      'The absence-preserving forms never appear here: `?? undefined` invents',
      "nothing, and `?? null` / `?? ''` narrow absent to absent, so the surface",
      'and a validator reading the raw value agree. `?? 0`, `?? false` and any',
      "other non-empty literal stay violations. `|| ''` is a violation too — `||`",
      "is falsy-triggered, so `0 || ''` paints empty where the raw value is 0,",
      'the same shape as `|| 22`.',
      '',
      'Each entry carries the one-line reason that makes it acceptable to keep.',
      'When the reason stops holding, delete the entry (or regenerate — the updater',
      'copies reasons forward by key and refuses to grow).',
    ],
    violations: entries,
  },
  null,
  2,
)

writeFileSync(BASELINE_PATH, content + '\n')

const shrunk = oldBaseline.size - byKey.size
const change = shrunk > 0 ? ` (shrunk by ${shrunk})` : ''
console.log(
  `Baseline written: ${byKey.size} violations across ${new Set(entries.map((e) => e.file)).size} files.${change}`,
)
