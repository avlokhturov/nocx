#!/usr/bin/env node
/**
 * The coverage receipt: every spec file on disk is collected by some project.
 *
 * This exists because the suite has twice lost whole files silently. Seven
 * specs were excluded from the `wails dev` run by a hand-written list in
 * playwright.config.ts and were only run by a separate CI job; when CI stopped
 * building the binary they need, all seven failed on their first line and the
 * green-looking shards said nothing about it (nocx-azxe.2). A hand-written
 * list cannot report a file that is on neither list — only a comparison
 * against the filesystem can.
 *
 * So the question asked here is not "does the config look right" but "is there
 * a spec file that no project would run". `--list` answers what Playwright
 * actually collects, which is the only answer that counts.
 *
 * Files that are deliberately not collected by the default run declare it
 * themselves, by living under a directory this script knows is owned by a
 * named project. Adding a spec to such a directory is a visible decision;
 * forgetting to list one is not.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const e2eDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(e2eDir, '..')

/** Directories whose specs belong to a named project rather than the default
 *  browser projects. Each must be matched by a project in
 *  playwright.config.ts; a directory here that no project claims is itself a
 *  failure, because it would silently run nothing. */
const PROJECT_DIRS = ['wails']

function specFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...specFiles(full))
    } else if (entry.endsWith('.spec.ts')) {
      out.push(full)
    }
  }
  return out
}

const onDisk = specFiles(e2eDir).map((f) => relative(repoRoot, f))

// --list does not start the webServer, so this is cheap and side-effect free.
const listed = execFileSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

const report = JSON.parse(listed)
const collected = new Set()
let cases = 0
const walk = (suites) => {
  for (const s of suites ?? []) {
    if (s.file) collected.add(s.file)
    cases += s.specs?.length ?? 0
    walk(s.suites)
  }
}
walk(report.suites)

const missing = onDisk.filter(
  (f) =>
    !collected.has(relative(join(repoRoot, 'e2e'), join(repoRoot, f))) &&
    !collected.has(f) &&
    !collected.has(f.split(sep).slice(1).join('/')),
)

if (missing.length > 0) {
  console.error('COVERAGE: spec files no project collects:')
  for (const f of missing) console.error(`  ${f}`)
  console.error('')
  console.error('Either the default projects should collect it, or it belongs in one of the')
  console.error(`project-owned directories (${PROJECT_DIRS.map((d) => `e2e/${d}/`).join(', ')})`)
  console.error('and a project in playwright.config.ts must claim that directory.')
  process.exit(1)
}

// Counted from the listing, not from report.stats.expected: `--list` never runs
// anything, so `expected` is 0 and the receipt read "36 spec files collected, 0
// tests" — a line whose second half says the opposite of its first, on a gate
// whose whole job is to be believed (nocx-z9s9.8).
console.log(`COVERAGE OK — ${collected.size} spec files collected, ${cases} test cases`)
