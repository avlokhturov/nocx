#!/usr/bin/env node
/**
 * Control-plane goroutine ratchet — no `go` statements in control-handler
 * code, baselined.
 *
 * The control plane's scheduling contract (ADR-0026) says every piece of
 * control work runs on the read loop, on the bounded lane, or on the
 * ordered per-session lanes — and that a handler which spawns its own
 * goroutine escapes context, admission, conflict ownership and shutdown
 * accounting. Go cannot remove the `go` keyword, so the available structural
 * check is this ratchet: every `go` statement in the control-handler
 * packages must be one of the baselined infrastructure spawn sites below.
 * A new spawn — from a handler or anywhere else — fails the gate and is a
 * review decision that shows up in the diff.
 *
 * Scope: the packages that implement control handlers and the scheduling
 * contract:
 *
 *   - internal/transport        (the ws_*.go handlers + read loop + pumps)
 *   - internal/transport/control (the scheduling contract itself)
 *   - internal/capability       (the typed domain operations)
 *
 * Test files are excluded: tests legitimately exercise concurrency, and the
 * boundary proof for production code is what this gate guards.
 *
 * Policy: the baseline may only be changed by the update script, which
 * preserves every existing justification and stamps empty ones on new
 * entries — an un-justified spawn does not clear the gate silently. A
 * baseline that grew is itself reviewable in the diff.
 *
 * Invocation: node .githooks/check-control-goroutines.mjs   (from the repo root)
 * Regenerate: node .githooks/update-control-goroutines-baseline.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const BASELINE_PATH = join(__dirname, 'control-goroutines-baseline.json')

// The packages whose non-test Go files must contain no un-baselined `go`
// statement. Directories are relative to the repo root.
const SCOPED_DIRS = ['internal/transport', 'internal/transport/control', 'internal/capability']

// A `go` statement is a statement that begins with the keyword: `go expr`
// at the start of a line (gofmt places it there; a `go` mid-line is not a
// statement). The captured text is everything after the keyword, trimmed.
const GO_STMT_RE = /^\s*go\s+(.+)$/

/** Scan the scoped directories and return spawns as {file, text} records. */
export function collectControlGoroutines() {
  const spawns = []
  for (const dir of SCOPED_DIRS) {
    const abs = join(PROJECT_ROOT, dir)
    let entries
    try {
      entries = readdirSync(abs)
    } catch {
      continue // a directory that does not exist cannot spawn anything
    }
    for (const name of entries.sort()) {
      if (!name.endsWith('.go') || name.endsWith('_test.go')) continue
      const content = readFileSync(join(abs, name), 'utf8')
      content.split('\n').forEach((line) => {
        const m = GO_STMT_RE.exec(line)
        if (m) spawns.push({ file: `${dir}/${name}`, text: m[1].trim() })
      })
    }
  }
  return spawns
}

/** Load the committed baseline: {"file:text": "justification"}. */
export function loadBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

// ─── CLI entry point ─────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseline = loadBaseline()
  const spawns = collectControlGoroutines()

  const offenders = spawns.filter((s) => !(s.file + ':' + s.text in baseline))
  if (offenders.length > 0) {
    console.error(
      `FAIL: ${offenders.length} un-baselined \`go\` statement(s) in control-handler code — ` +
        'a handler goroutine escapes context, admission, conflict ownership and shutdown ' +
        'accounting (ADR-0026). Regenerate the baseline only for genuine infrastructure spawns: ' +
        'node .githooks/update-control-goroutines-baseline.mjs',
    )
    for (const o of offenders) {
      console.error(`  ${o.file}: go ${o.text}`)
    }
    process.exit(1)
  }

  // A baseline entry that no longer matches any spawn is a stale exception:
  // it must be removed, not kept as a permission slip.
  const keys = new Set(spawns.map((s) => s.file + ':' + s.text))
  const stale = Object.keys(baseline).filter((k) => !keys.has(k))
  if (stale.length > 0) {
    console.error(
      `FAIL: ${stale.length} baseline entr(ies) no longer match any \`go\` statement — ` +
        'remove them (the baseline is a justification list, not a permission ledger):',
    )
    for (const k of stale) console.error(`  ${k}`)
    process.exit(1)
  }

  console.log(
    `OK — control goroutine ratchet: ${spawns.length} baselined infrastructure spawn(s), 0 new`,
  )
}
