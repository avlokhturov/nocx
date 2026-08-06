#!/usr/bin/env node
/**
 * Dead-export ratchet — knip, baselined.
 *
 * knip answers one question: "does this export have a consumer?" It resolves
 * the real import graph from the entry points in knip.json (index.html →
 * src/main.tsx, the vite/vitest configs, the eslint config, and the tooling
 * scripts) and reports exports, exported types and files nothing reaches.
 * That is a floor, and a narrow one:
 *
 *   - It cannot see a member of a reachable export that is never *read* — a
 *     `readonly` field written by four call sites and read by none is invisible
 *     to it, exactly like `restoreDescriptor` in this very tree (tabs.ts:456,
 *     tabs.ts:504, main.tsx:226, state/tab-model.ts:255): a member of one
 *     object, not an export of any module. Reachability and export-consumption
 *     are not consumption.
 *   - It analyzes only TypeScript/JavaScript; nothing Go reaches is its concern
 *     (that is the job of deadcode via .githooks/check-deadcode.mjs).
 *   - It cannot see a CJS require made through `createRequire` (the CSS
 *     checkers load css-tree that way), so dependency reporting has blind
 *     spots; the ratchet therefore gates only unused files, exports and types,
 *     and reports dependency noise as informational.
 *
 * Do not read a green gate as proof that no dead paths exist. The criterion
 * stays what AGENTS.md says: every epic proves its happy path end to end.
 *
 * Policy: existing violations are baselined warnings; a violation knip reports
 * that the baseline does not list is new and fails the pre-commit hook. The
 * baseline may only shrink — removing an entry is always a pass. Regenerate
 * with `node lint-fixtures/update-dead-exports-baseline.mjs`, which refuses
 * to write a baseline that grows.
 *
 * Invocation: node lint-fixtures/check-dead-exports.mjs   (from frontend/)
 * NOCX_BASELINE_UPDATE=1 prints every violation without failing, the same
 * escape hatch the CSS checkers use for their fixture gates.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(__dirname, '..')
const BASELINE_PATH = resolve(__dirname, 'dead-exports-baseline.json')
const KNIP_BIN = resolve(FRONTEND_DIR, 'node_modules/.bin/knip')

// The ratchet owns unused files, exports and exported types — the dead-code
// surface. Dependency noise (unused/unlisted deps, binaries, unresolved) is
// reported but never gating: knip cannot see createRequire imports, so a gate
// over deps would fail on css-tree every commit.
const RATCHET_KINDS = new Set(['exports', 'types', 'files'])
const INFORMATIONAL_KINDS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalPeerDependencies',
  'binaries',
  'unlisted',
  'unresolved',
  'catalog',
  'catalogReferences',
  'duplicates',
  'enumMembers',
  'namespaceMembers',
])

/**
 * Run knip and return the normalized ratchet violation list.
 * Deterministic: one spawn against the local binary (never npx, which could
 * fetch the network), `--no-exit-code` so a nonzero exit means a real tool
 * failure (bad config, missing file) and is never a pass, and the JSON
 * reporter parsed — never the human table. Sorted by kind/file/symbol so the
 * diff against the baseline is order-independent.
 */
export function collectKnipViolations() {
  const proc = spawnSync(KNIP_BIN, ['--reporter', 'json', '--no-exit-code'], {
    cwd: FRONTEND_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  if (proc.status !== 0) {
    const detail = (proc.stderr || proc.stdout || '').trim()
    throw new Error(`knip exited ${proc.status}${detail ? `:\n${detail}` : ''}`)
  }

  let data
  try {
    data = JSON.parse(proc.stdout)
  } catch {
    throw new Error('knip produced unparseable JSON output')
  }

  const violations = []
  const informational = []
  for (const fileIssues of data.issues) {
    const file = fileIssues.file
    for (const [kind, items] of Object.entries(fileIssues)) {
      if (RATCHET_KINDS.has(kind)) {
        for (const item of items) {
          if (kind === 'files') {
            violations.push({ kind, file, symbol: '' })
          } else {
            violations.push({ kind, file, symbol: item.name })
          }
        }
      } else if (INFORMATIONAL_KINDS.has(kind)) {
        for (const item of items) {
          informational.push({ kind, file, symbol: item.name ?? item })
        }
      }
    }
  }

  violations.sort((a, b) =>
    `${a.kind}:${a.file}:${a.symbol}`.localeCompare(`${b.kind}:${b.file}:${b.symbol}`),
  )
  informational.sort((a, b) =>
    `${a.kind}:${a.file}:${a.symbol}`.localeCompare(`${b.kind}:${b.file}:${b.symbol}`),
  )
  return { violations, informational }
}

export function violationKey(v) {
  return `${v.kind}:${v.file}:${v.symbol}`
}

function loadBaseline() {
  try {
    const data = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    return new Map(data.violations.map((v) => [violationKey(v), v]))
  } catch {
    return new Map() // no baseline: every violation is new
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let violations, informational
  try {
    ;({ violations, informational } = collectKnipViolations())
  } catch (err) {
    console.error(`DEAD-EXPORTS RATCHET: ${err.message}`)
    process.exit(1)
  }

  const useBaseline = process.env.NOCX_BASELINE_UPDATE !== '1'
  const baselineMap = useBaseline ? loadBaseline() : new Map()

  const unbaselined = violations.filter((v) => !baselineMap.has(violationKey(v)))
  const shrunk = baselineMap.size - [...new Set(violations.map(violationKey))].length

  for (const v of violations) {
    console.log(JSON.stringify(v))
  }

  const infoNote = informational.length
    ? ` (plus ${informational.length} dependency/unresolved items reported but not gating)`
    : ''

  if (unbaselined.length > 0) {
    console.error(
      `DEAD-EXPORTS RATCHET: ${violations.length} violations (${baselineMap.size} baselined, ${shrunk > 0 ? `shrunk by ${shrunk}, ` : ''}${unbaselined.length} NEW)${infoNote}:`,
    )
    for (const v of unbaselined) {
      console.error(`  NEW: ${v.file}: ${v.kind === 'file' ? '(unused file)' : v.symbol}`)
    }
    if (useBaseline) process.exitCode = 1
  } else {
    const shrinkNote = shrunk > 0 ? ` (baseline shrunk by ${shrunk})` : ''
    console.error(
      `DEAD-EXPORTS RATCHET: ${violations.length} violations, all baselined${shrinkNote}${infoNote}.`,
    )
  }
}
