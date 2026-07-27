#!/usr/bin/env node
/**
 * CSS integrity checker — the stylesheet is internally consistent.
 *
 * The colour grammar checker (check-css-colors.mjs) proves colour *values* are
 * tokens. It cannot see the four ways the token layer shipped broken in
 * nocx-u7wq, because every one of them is valid CSS that the parser accepts
 * silently:
 *
 *   unreachable   A .css file under styles/ that nothing @imports. It is not
 *                 an error to write a stylesheet and never load it.
 *   escaped-dot   `\.kit-scope` is a *type* selector for an element named
 *                 ".kit-scope" — well-formed, and matches nothing that can
 *                 exist in HTML. 21 kit rules were dead this way.
 *   undefined-var `font-family: var(--font-family-mono)` where no rule
 *                 declares that property. The declaration is invalid at
 *                 computed-value time and the element silently inherits.
 *   theme-scope   A theme file selecting bare `:root` applies unconditionally,
 *                 so a second theme cannot override it except by import order.
 *
 * All four are invisible to the browser, to eslint, and to jsdom tests. A
 * linter is the only thing that can see them, which is why this file exists.
 *
 * Invocation:
 *   node lint-fixtures/check-css-integrity.mjs
 *   node lint-fixtures/check-css-integrity.mjs --entry=<css> --styles=<dir>
 *
 * Violations print as JSON Lines on stdout and a human summary on stderr;
 * exit code 1 if any fired.
 */

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, relative, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FRONTEND_DIR = resolve(__dirname, '..')
const PROJECT_ROOT = resolve(FRONTEND_DIR, '..')

const css = createRequire(import.meta.url)('css-tree')

/**
 * The one theme file allowed to carry a bare `:root` block — the default
 * applied when no `data-theme` attribute is present. Every other theme file
 * must scope all of its rules to its own `[data-theme]` value.
 *
 * Attribute-scoped theme rules are written `:root[data-theme='id']`
 * (specificity 0,2,0) so they outrank this default (0,1,0) regardless of the
 * order the files are imported in. Relying on import order is what makes a
 * missing @import look like a working theme switch.
 */
const DEFAULT_THEME_FILE = 'tokyo-night.css'

/**
 * Custom properties written by code rather than by a stylesheet, or read by
 * the host rather than by CSS. A var() reference to one of these is not a
 * missing declaration.
 */
const EXTERNALLY_DECLARED = new Set([
  // Wails reads these off computed style; nothing var()s them.
  '--wails-draggable',
  '--default-contextmenu',
])

// ── Import graph ───────────────────────────────────────────────────────────

/** Parse the `@import` targets of one file, resolved to absolute paths. */
function importsOf(absPath, text) {
  const targets = []
  let ast
  try {
    ast = css.parse(text, { positions: true })
  } catch {
    return targets
  }
  css.walk(ast, (node) => {
    if (node.type !== 'Atrule' || node.name !== 'import' || !node.prelude) return
    const raw = css.generate(node.prelude).trim()
    const m = raw.match(/^(?:url\()?['"]?([^'")]+)['"]?\)?/)
    if (!m) return
    const spec = m[1]
    if (/^[a-z]+:/i.test(spec)) return // remote — not ours to resolve
    targets.push(resolve(dirname(absPath), spec))
  })
  return targets
}

/** Every file transitively reachable from the entry, entry included. */
function reachableFrom(entryAbs) {
  const seen = new Set()
  const queue = [entryAbs]
  while (queue.length > 0) {
    const cur = queue.pop()
    if (seen.has(cur) || !existsSync(cur)) continue
    seen.add(cur)
    for (const next of importsOf(cur, readFileSync(cur, 'utf8'))) queue.push(next)
  }
  return seen
}

/** Every .css file under a directory, recursively. */
function allCSSUnder(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allCSSUnder(full))
    else if (entry.isFile() && entry.name.endsWith('.css')) out.push(full)
  }
  return out
}

// ── Per-file scans ─────────────────────────────────────────────────────────

/**
 * Selectors carrying an escaped dot.
 *
 * css-tree parses `\.kit-scope` into a TypeSelector whose name starts with a
 * backslash, which is precisely the tell: no HTML element name begins with
 * one. Checking the AST rather than the raw text keeps `content: "\.";` and
 * escaped dots inside strings out of the results.
 */
function findEscapedDotSelectors(ast) {
  const found = []
  css.walk(ast, (node) => {
    if (node.type !== 'TypeSelector' && node.type !== 'IdentSelector') return
    if (!node.name || !node.name.startsWith('\\')) return
    found.push({
      selector: node.name,
      line: node.loc ? node.loc.start.line : 0,
    })
  })
  return found
}

/** Custom properties declared (`--x: …`) and referenced (`var(--x)`) in a file. */
function collectCustomProperties(ast) {
  const declared = new Set()
  const referenced = []

  css.walk(ast, (node) => {
    if (node.type === 'Declaration' && node.property.startsWith('--')) {
      declared.add(node.property)
    }
    if (node.type === 'Function' && node.name === 'var') {
      const first = node.children && node.children.first
      if (!first || first.type !== 'Identifier' || !first.name.startsWith('--')) return
      // A fallback (`var(--x, monospace)`) makes the reference safe even when
      // --x is undefined, so only bare references are candidates.
      const hasFallback = node.children.size > 1
      if (hasFallback) return
      referenced.push({ name: first.name, line: node.loc ? node.loc.start.line : 0 })
    }
  })

  return { declared, referenced }
}

/**
 * Theme files must scope their rules to their own `data-theme` value.
 * Returns the rules that do not.
 */
function findUnscopedThemeRules(ast, themeId, isDefaultTheme) {
  const found = []
  const attr = `[data-theme='${themeId}']`
  const attrAlt = `[data-theme="${themeId}"]`

  css.walk(ast, (node) => {
    if (node.type !== 'Rule' || !node.prelude || node.prelude.type !== 'SelectorList') return
    for (const selector of node.prelude.children) {
      const text = css.generate(selector).trim()
      if (text.includes(attr) || text.includes(attrAlt)) continue
      // A bare `:root` is the documented default — allowed in exactly one file.
      if (text === ':root' && isDefaultTheme) continue
      found.push({
        selector: text,
        line: selector.loc ? selector.loc.start.line : 0,
      })
    }
  })

  return found
}

// ── Checker ────────────────────────────────────────────────────────────────

/**
 * Rule 4 — a component stylesheet may only address its own identities.
 *
 * A bare type selector in `styles/components/` is a rule that matches by element
 * rather than by identity, which means any surface that happens to render that
 * element collides with it. That is exactly how the kit's controls came to be styled
 * through an ancestor: the rules named `input` and `select`, so they needed a scope
 * to stop them applying everywhere.
 *
 * `base.css` is deliberately NOT covered — it is not component CSS, and it is where
 * the application-wide focus ring lives (design spec §3.2).
 */
function findBareTypeSelectors(ast) {
  const hits = []
  css.walk(ast, {
    visit: 'Rule',
    enter(node) {
      // `from`, `to` and `50%` inside @keyframes are keyframe selectors, not type
      // selectors. css-tree parses them as Rules all the same.
      if (this.atrule && /keyframes$/i.test(this.atrule.name)) return
      css.walk(node.prelude, {
        visit: 'Selector',
        enter(sel) {
          const first = sel.children.first
          if (!first || first.type !== 'TypeSelector') return
          // A type selector is fine when something narrows it to an identity in the
          // same compound — `input.ui-text-field__input` addresses the component.
          let narrowed = false
          let n = sel.children.head?.next
          while (n && n.data.type !== 'Combinator') {
            if (n.data.type === 'ClassSelector') narrowed = true
            n = n.next
          }
          if (narrowed) return
          hits.push({ selector: css.generate(sel), line: sel.loc?.start.line ?? 0 })
        },
      })
    },
  })
  return hits
}

/**
 * Rule 11, strong-signal tier — control CSS outside the kit.
 *
 * These have no non-control use. `appearance` only exists to strip platform chrome;
 * `::placeholder`, `::file-selector-button` and the WebKit spin/search pseudos only
 * exist on form controls; `:checked::after` draws a state only a control has. A
 * surface declaring any of them is hand-rolling a control the kit already owns.
 *
 * The weaker tier from the design — background + border + padding together — is
 * deliberately NOT here. Measured, it fires on `.cm-credential-card` and
 * `.st-export-backup-details`, which are ordinary cards, and a rule that reports
 * correct code gets disabled. That tier needs the selector traced back to JSX first.
 */
const CONTROL_FINGERPRINTS = [
  /(^|[^-\w])appearance\s*:/,
  /::placeholder/,
  /::file-selector-button/,
  /::-webkit-(inner|outer)-spin-button/,
  /::-webkit-search-(decoration|results-button)/,
  /:checked::after/,
]

function findControlFingerprints(source) {
  const hits = []
  source.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('/*') || line.trim().startsWith('*')) return
    for (const re of CONTROL_FINGERPRINTS) {
      if (re.test(line)) {
        hits.push({ line: i + 1, snippet: line.trim().slice(0, 70) })
        break
      }
    }
  })
  return hits
}

export function checkCSSIntegrity({ entry, stylesDir }) {
  const violations = []
  const entryAbs = resolve(entry)
  const stylesAbs = resolve(stylesDir)
  const rel = (p) => relative(PROJECT_ROOT, resolve(p))

  const reachable = reachableFrom(entryAbs)

  // ── unreachable ─────────────────────────────────────────────────────────
  for (const file of allCSSUnder(stylesAbs)) {
    if (reachable.has(resolve(file))) continue
    violations.push({
      rule: 'unreachable',
      file: rel(file),
      line: 0,
      detail: `not reachable from ${rel(entryAbs)} — nothing @imports it`,
    })
  }

  // ── per-file AST scans over the reachable set ───────────────────────────
  const declaredEverywhere = new Set(EXTERNALLY_DECLARED)
  const referencedEverywhere = []

  for (const file of [...reachable].sort()) {
    let ast
    try {
      ast = css.parse(readFileSync(file, 'utf8'), { positions: true })
    } catch {
      continue
    }

    for (const hit of findEscapedDotSelectors(ast)) {
      violations.push({
        rule: 'escaped-dot',
        file: rel(file),
        line: hit.line,
        detail: `\`${hit.selector}\` is a type selector for an element of that name, not a class — drop the backslash`,
      })
    }

    // Rule 11 (strong tier) applies everywhere EXCEPT component stylesheets, which
    // are where controls legitimately live.
    if (!resolve(file).startsWith(resolve(stylesAbs, 'components'))) {
      for (const hit of findControlFingerprints(readFileSync(file, 'utf8'))) {
        violations.push({
          rule: 'control-css-outside-kit',
          file: rel(file),
          line: hit.line,
          detail: `\`${hit.snippet}\` only exists on form controls — the kit owns those, so this is hand-rolling one`,
        })
      }
    }

    // Rule 4 applies to component stylesheets only.
    if (resolve(file).startsWith(resolve(stylesAbs, 'components'))) {
      for (const hit of findBareTypeSelectors(ast)) {
        violations.push({
          rule: 'bare-type-selector',
          file: rel(file),
          line: hit.line,
          detail: `\`${hit.selector}\` matches by element, not by identity — any surface rendering that element collides with it`,
        })
      }
    }

    const { declared, referenced } = collectCustomProperties(ast)
    for (const name of declared) declaredEverywhere.add(name)
    for (const ref of referenced) referencedEverywhere.push({ ...ref, file })

    const inThemes = resolve(file).startsWith(resolve(stylesAbs, 'themes'))
    if (inThemes) {
      const name = basename(file)
      const themeId = name.replace(/\.css$/, '')
      for (const hit of findUnscopedThemeRules(ast, themeId, name === DEFAULT_THEME_FILE)) {
        violations.push({
          rule: 'theme-scope',
          file: rel(file),
          line: hit.line,
          detail: `\`${hit.selector}\` is not scoped to [data-theme='${themeId}'] — it would apply under every theme`,
        })
      }
    }
  }

  // ── undefined-var (needs every file's declarations first) ───────────────
  for (const ref of referencedEverywhere) {
    if (declaredEverywhere.has(ref.name)) continue
    violations.push({
      rule: 'undefined-var',
      file: rel(ref.file),
      line: ref.line,
      detail: `var(${ref.name}) has no declaration in the loaded cascade and no fallback`,
    })
  }

  return violations
}

// ── CLI entry point ────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (flag, fallback) => {
    const found = process.argv.find((a) => a.startsWith(`--${flag}=`))
    return found ? resolve(FRONTEND_DIR, found.slice(flag.length + 3)) : fallback
  }

  const entry = arg('entry', resolve(FRONTEND_DIR, 'src/style.css'))
  const stylesDir = arg('styles', resolve(FRONTEND_DIR, 'src/styles'))

  const violations = checkCSSIntegrity({ entry, stylesDir })

  for (const v of violations) console.log(JSON.stringify(v))

  if (violations.length > 0) {
    const byRule = new Map()
    for (const v of violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1)
    const summary = [...byRule].map(([r, n]) => `${r}: ${n}`).join(', ')
    console.error(`CSS integrity violations: ${violations.length} (${summary}).`)
    for (const v of violations) {
      console.error(`  ${v.rule} ${v.file}:${v.line} — ${v.detail}`)
    }
    process.exitCode = 1
  }
}
