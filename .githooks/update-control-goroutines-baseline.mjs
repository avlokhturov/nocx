#!/usr/bin/env node
/**
 * Regenerate .githooks/control-goroutines-baseline.json from the current
 * scoped packages. Existing justifications are preserved; new spawns are
 * stamped with an empty justification and printed so the committer fills
 * them in — an un-justified entry is exactly as visible as a new spawn.
 *
 * Invocation: node .githooks/update-control-goroutines-baseline.mjs
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectControlGoroutines, loadBaseline } from './check-control-goroutines.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = join(__dirname, 'control-goroutines-baseline.json')

const old = (() => {
  try {
    return loadBaseline()
  } catch {
    return {} // first run: no baseline exists yet
  }
})()
const spawns = collectControlGoroutines()

const next = {}
const missing = []
for (const s of spawns) {
  const key = s.file + ':' + s.text
  if (key in old) {
    next[key] = old[key]
  } else {
    next[key] = ''
    missing.push(key)
  }
}

// The baseline is a justification list: an entry that no longer matches any
// spawn is dropped, never kept.
for (const key of Object.keys(old)) {
  if (!(key in next)) {
    console.error(`dropped stale baseline entry: ${key}`)
  }
}

writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n')

if (missing.length > 0) {
  console.error(
    `WARNING: ${missing.length} new spawn(s) added with EMPTY justifications — ` +
      'edit the baseline and justify each before committing:',
  )
  for (const m of missing) console.error(`  ${m}`)
  process.exit(1)
}
console.log(`OK — baseline written: ${Object.keys(next).length} entries`)
