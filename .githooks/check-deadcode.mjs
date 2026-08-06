#!/usr/bin/env node
/**
 * Dead-code ratchet — `deadcode` (golang.org/x/tools/cmd/deadcode), baselined.
 *
 * deadcode answers one question: "is this Go function reachable from main()?"
 * It runs Rapid Type Analysis over the module and reports every function no
 * executable reaches, grouping by package. That is a floor, and a narrow one:
 *
 *   - It does not report a function that is reachable but never *read* — a
 *     `readonly` field written by four call sites and read by none is invisible
 *     to it, exactly like `restoreDescriptor` in the frontend (tabs.ts:456,
 *     main.tsx:226, state/tab-model.ts:255). Reachability is not consumption.
 *   - It analyzes only Go; nothing TypeScript reaches is its concern (that is
 *     the job of knip via lint-fixtures/check-dead-exports.mjs).
 *   - Without -test it counts test-only helpers as dead (86 on 2026-08-06; 9
 *     with -test), so the committed baseline includes them and they may only
 *     shrink. Do not read a green gate as proof that no dead paths exist.
 *
 * Policy: existing violations are baselined warnings; a function deadcode
 * reports that the baseline does not list is a new violation and fails the
 * pre-commit hook. The baseline may only shrink — removing an entry is always
 * a pass. Regenerate with `node .githooks/update-deadcode-baseline.mjs`,
 * which refuses to write a baseline that grows.
 *
 * Invocation: node .githooks/check-deadcode.mjs   (from the repo root)
 * NOCX_BASELINE_UPDATE=1 prints every violation without failing, the same
 * escape hatch the CSS checkers use for their fixture gates.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const BASELINE_PATH = resolve(__dirname, 'deadcode-baseline.json')

// Overridable so a pinned binary can be tested; defaults to PATH lookup,
// which the pre-commit hook primes with $(go env GOPATH)/bin.
const DEADCODE_CMD = process.env.DEADCODE || 'deadcode'

const UNREACHABLE_RE = /^(.+?):\d+:\d+: unreachable func: (.+)$/

/**
 * Run deadcode from the repo root and return the normalized violation list.
 * Deterministic: one spawn, stdout and stderr both captured, keys sorted, and
 * any output line the parser does not understand fails loudly rather than
 * silently passing (a format change in a newer deadcode must not look like a
 * clean tree). A nonzero exit is a tool failure (module does not compile, the
 * binary is missing) and is never a pass.
 */
export function collectDeadcodeViolations() {
  const proc = spawnSync(DEADCODE_CMD, ['./...'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  if (proc.status !== 0) {
    const detail = (proc.stderr || proc.stdout || '').trim()
    throw new Error(`deadcode exited ${proc.status}${detail ? `:\n${detail}` : ''}`)
  }

  const violations = []
  for (const line of proc.stdout.split('\n')) {
    if (line === '') continue
    // node_modules ships third-party Go (e.g. flatted/golang), which deadcode
    // picks up whenever npm has run. It is not our code and not ours to
    // ratchet — the baseline is defined over this repo's packages only, and
    // `go list ./...` on a machine without node_modules would say the same.
    // Match a leading `node_modules/` too, not only `…/node_modules/`: the
    // path deadcode prints is relative to ITS working directory, so running
    // from frontend/ yields `node_modules/flatted/…` with no leading slash
    // and a `/node_modules/` test silently stops filtering. That cost a
    // worker a red gate and a paragraph of report on 2026-08-06.
    if (line.includes('/node_modules/') || line.startsWith('node_modules/')) continue
    const m = UNREACHABLE_RE.exec(line)
    if (!m) {
      throw new Error(`unparseable deadcode output line: ${line}`)
    }
    violations.push({ file: m[1], func: m[2] })
  }

  violations.sort((a, b) => `${a.file}:${a.func}`.localeCompare(`${b.file}:${b.func}`))
  return violations
}

export function violationKey(v) {
  return `${v.file}:${v.func}`
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
  let violations
  try {
    violations = collectDeadcodeViolations()
  } catch (err) {
    console.error(`DEADCODE RATCHET: ${err.message}`)
    process.exit(1)
  }

  const useBaseline = process.env.NOCX_BASELINE_UPDATE !== '1'
  const baselineMap = useBaseline ? loadBaseline() : new Map()

  const unbaselined = violations.filter((v) => !baselineMap.has(violationKey(v)))
  const shrunk = baselineMap.size - [...new Set(violations.map(violationKey))].length

  for (const v of violations) {
    console.log(JSON.stringify(v))
  }

  if (unbaselined.length > 0) {
    console.error(
      `DEADCODE RATCHET: ${violations.length} unreachable functions (${baselineMap.size} baselined, ${shrunk > 0 ? `shrunk by ${shrunk}, ` : ''}${unbaselined.length} NEW):`,
    )
    for (const v of unbaselined) {
      console.error(`  NEW: ${v.file}: ${v.func}`)
    }
    if (useBaseline) process.exitCode = 1
  } else {
    const shrinkNote = shrunk > 0 ? ` (baseline shrunk by ${shrunk})` : ''
    console.error(
      `DEADCODE RATCHET: ${violations.length} unreachable functions, all baselined${shrinkNote}.`,
    )
  }
}
