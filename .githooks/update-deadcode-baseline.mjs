#!/usr/bin/env node
/**
 * Regenerate `.githooks/deadcode-baseline.json` from the current deadcode
 * output.
 *
 * Usage: node .githooks/update-deadcode-baseline.mjs   (from the repo root)
 *        --platform=<goos>/<goarch>, --tags=<a,b>      as check-deadcode.mjs
 *
 * This is a deliberate regeneration: the baseline must be explicitly updated
 * (run this command) rather than being a side effect of the gate. Growth
 * guard, mirroring lint-fixtures/update-raw-controls-baseline.mjs: refuses to
 * write a baseline that contains a violation absent from the existing one.
 * Only pure shrink or no-change is allowed, so regeneration cannot silently
 * legitimize new dead code. Removing entries (the fix for dead code) is the
 * one direction that never fails.
 *
 * AND IT MAY ONLY PRUNE WHAT IT CAN SEE. The baseline is the union over the
 * two platforms this product ships to; since Wails v3 made cgo mandatory,
 * deadcode can only analyse the host's own platform (check-deadcode.mjs
 * carries that whole story). A naive regeneration on Linux would therefore
 * drop every darwin-only entry — `secretservice_other.go SecretServiceAvailable`
 * is exactly one such — and the macOS CI job would then report it as a NEW
 * violation on the next pull request. That is nocx-0odm's bug returning by the
 * other door.
 *
 * So an old entry is removed only when this platform actually COMPILED the
 * file it names and deadcode did not report it. `go list` answers "compiled
 * here" exactly and per platform — a file excluded by a build constraint lands
 * in IgnoredGoFiles and never in GoFiles/CgoFiles — so an entry from the other
 * platform's half is preserved verbatim rather than guessed at, and the
 * baseline needs no new format to carry it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectDeadcodeViolations,
  hostPlatform,
  resolveBuildTags,
  resolvePlatform,
  violationKey,
} from './check-deadcode.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const BASELINE_PATH = resolve(__dirname, 'deadcode-baseline.json')

/**
 * The set of repo-relative .go files the toolchain compiles for `platform`,
 * in the same path form deadcode prints. Cheap and non-compiling, so it works
 * for any GOOS even where cgo could not build.
 */
function compiledFiles(platform, tags) {
  const proc = spawnSync(
    'go',
    [
      'list',
      ...(tags ? ['-tags', tags] : []),
      '-f',
      '{{$d := .Dir}}{{range .GoFiles}}{{$d}}/{{.}}\n{{end}}{{range .CgoFiles}}{{$d}}/{{.}}\n{{end}}',
      './...',
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...platform },
    },
  )
  if (proc.status !== 0) {
    throw new Error(
      `go list failed for ${platform.GOOS}/${platform.GOARCH}: ${(proc.stderr || '').trim()}`,
    )
  }
  const files = new Set()
  for (const line of proc.stdout.split('\n')) {
    if (line === '') continue
    files.add(relative(PROJECT_ROOT, line))
  }
  return files
}

// ─── Load existing baseline ────────────────────────────────────────────────
const oldBaseline = new Map()
if (existsSync(BASELINE_PATH)) {
  const data = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  for (const v of data.violations) {
    oldBaseline.set(violationKey(v), v)
  }
}

// ─── Collect current violations ────────────────────────────────────────────
let violations
let platform
let compiled
try {
  const host = hostPlatform()
  platform = resolvePlatform(process.argv.slice(2), host)
  const tags = resolveBuildTags(process.argv.slice(2), host)
  console.log(
    `Running deadcode for ${platform.GOOS}/${platform.GOARCH}${tags ? ` -tags ${tags}` : ''}...`,
  )
  violations = collectDeadcodeViolations(platform, tags)
  compiled = compiledFiles(platform, tags)
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

// ─── Preserve what this platform cannot see ────────────────────────────────
const current = new Set(violations.map(violationKey))
const preserved = [...oldBaseline.values()].filter(
  (v) => !current.has(violationKey(v)) && !compiled.has(v.file),
)
const pruned = [...oldBaseline.values()].filter(
  (v) => !current.has(violationKey(v)) && compiled.has(v.file),
)

const merged = [...violations, ...preserved]
merged.sort((a, b) => violationKey(a).localeCompare(violationKey(b)))

// ─── Write baseline ────────────────────────────────────────────────────────
const content = JSON.stringify(
  {
    '//': [
      'DO NOT EDIT MANUALLY. Regenerate with `node .githooks/update-deadcode-baseline.mjs`.',
      '',
      'Every entry is a Go function `deadcode ./...` reports unreachable from main().',
      'It may only shrink. A function deadcode reports that is not listed here is a',
      'new violation and fails the CI job that analysed that platform.',
      '',
      'The list is the UNION over darwin and linux. Wails v3 requires cgo, so no host',
      'can analyse both: ci.yml runs the ratchet per platform (ci-mac for darwin,',
      'ci-linux for linux) and each job sees a SUBSET of this file. That is why the',
      'updater prunes only entries whose file `go list` says the analysing platform',
      "compiled — dropping the other platform's half here is what made the gate",
      'unpassable on macOS while CI stayed silent (nocx-0odm, nocx-re6gk).',
      '',
      "Not a proof of no dead code: deadcode's RTA counts a method reached through",
      'an interface as reachable, so a dead method behind a live interface never',
      'appears here. Ask `deadcode -whylive <symbol>` for that.',
    ],
    violations: merged,
  },
  null,
  2,
)

writeFileSync(BASELINE_PATH, content + '\n')

console.log(
  `Baseline written: ${merged.length} unreachable functions ` +
    `(${violations.length} from ${platform.GOOS}/${platform.GOARCH}, ` +
    `${preserved.length} preserved from files this platform does not compile).`,
)
if (pruned.length > 0) {
  console.log(
    pruned.length === 1
      ? 'Pruned 1 entry that is now reachable:'
      : `Pruned ${pruned.length} entries that are now reachable:`,
  )
  for (const v of pruned) {
    console.log(`  ${v.file}: ${v.func}`)
  }
}
