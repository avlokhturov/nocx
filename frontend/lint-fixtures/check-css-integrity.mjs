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
 * It has since grown the rules of the kit-ownership design (2026-07-27) that are
 * statements about CSS rather than about JSX — rule 3 (surface-paints-kit), rule 4
 * (bare-type-selector), rule 6 (kit-scope-selector) and rule 11's strong tier
 * (control-css-outside-kit). Each is documented at its own function.
 *
 * Invocation:
 *   node lint-fixtures/check-css-integrity.mjs
 *   node lint-fixtures/check-css-integrity.mjs --entry=<css> --styles=<dir> --ui=<dir>
 *
 * `--ui` is where rule 3 derives its kit identities from; it defaults to the sibling
 * `ui/` of the styles directory.
 *
 * Violations print as JSON Lines on stdout and a human summary on stderr;
 * exit code 1 if any fired.
 */

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, relative, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanKitIdentities } from './scan-kit-identities.mjs'

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

/**
 * Rule 3 — a surface may not paint a kit component.
 *
 * The identity set is derived from the components' own JSX by AST (nocx-hav2), never
 * from the `ui-` prefix: `.ui-settings-row` and `.ui-settings-filter` carry the prefix
 * and no component renders them, so a prefix test would police the surface's own
 * classes and miss a component that named itself anything else.
 *
 * A parent may name a kit identity — it has no other way to say where the component
 * goes — but only for placement. That is nocx-zeti's decision, and its discriminator is
 * rule 11's property list, reused verbatim here so the two rules cannot drift into
 * disagreeing about what appearance is. `text-align`, `display`, `flex`, `width`,
 * `margin` and friends are placement and stay silent.
 *
 * Two shapes, because the second is not a special case of the first:
 *
 *   A. The subject IS a kit identity and the rule declares appearance —
 *      `.cm-root > .ui-toolbar { padding: … }`. The same component then looks
 *      different depending on where it is used, which is the defect in one line.
 *
 *   B. The subject is INSIDE a kit identity and has no class of its own —
 *      `.ui-field > .ui-field-label-col > label::before`, or
 *      `.activity-bar .ui-icon-button svg`. A surface cannot author a bare `label` or
 *      `svg` inside a component it does not render, so any such subject is the
 *      component's own markup being reached into, whatever the property. Tier B is
 *      therefore not filtered by the property list; the tunnel is the violation.
 *      A subject that carries a class is the surface's own element, passed in as
 *      children, and is nobody else's business.
 *
 * Not applied to `styles/components/` or `base.css` — those ARE the kit's layer, which
 * is where the paint is supposed to live.
 */
const APPEARANCE_PROPERTIES = [
  /^background/,
  /^border/,
  /^color$/,
  /^font/,
  /^box-shadow$/,
  /^padding/,
]

const isAppearanceProperty = (prop) =>
  APPEARANCE_PROPERTIES.some((re) => re.test(prop.replace(/^-{2}/, 'custom-')))

function findSurfacePaintingKit(ast, kitIdentities) {
  const hits = []
  css.walk(ast, {
    visit: 'Rule',
    enter(node) {
      const props = []
      css.walk(node.block, {
        visit: 'Declaration',
        enter(d) {
          props.push(d.property)
        },
      })
      if (props.length === 0) return

      css.walk(node.prelude, {
        visit: 'Selector',
        enter(sel) {
          // Split the selector into compounds; the last one is the subject.
          const compounds = [[]]
          sel.children.forEach((n) => {
            if (n.type === 'Combinator') compounds.push([])
            else compounds[compounds.length - 1].push(n)
          })
          const classesIn = (compound) =>
            compound.filter((n) => n.type === 'ClassSelector').map((n) => n.name)

          const subject = compounds[compounds.length - 1]
          const subjectClasses = classesIn(subject)
          const subjectIdentities = subjectClasses.filter((c) => kitIdentities.has(c))
          const ancestorIdentities = compounds
            .slice(0, -1)
            .flatMap(classesIn)
            .filter((c) => kitIdentities.has(c))

          const selector = css.generate(sel)
          const line = sel.loc?.start.line ?? 0

          if (subjectIdentities.length > 0) {
            const painted = props.filter(isAppearanceProperty)
            if (painted.length > 0) {
              hits.push({
                selector,
                line,
                detail: `declares ${painted.join(', ')} on \`.${subjectIdentities.join('.')}\` — appearance belongs to the component, not to where it is used`,
              })
            }
            return
          }

          if (ancestorIdentities.length > 0 && subjectClasses.length === 0) {
            hits.push({
              selector,
              line,
              detail: `reaches inside \`.${ancestorIdentities.join('.')}\` to style markup the component renders — that markup is not this file's to address`,
            })
          }
        },
      })
    },
  })
  return hits
}

/**
 * Rule 7 — untokenised type.
 *
 * A `font-size` in px and a `font-family` that is not a token are the two ways the type
 * scale gets bypassed: both are valid CSS, both look deliberate, and both mean the
 * next person changing the scale misses this rule. Not all px — `1px` borders and icon
 * geometry are legitimate, which is why the rule names its two properties and nothing
 * else.
 *
 * Exemptions carry a file, a value, a count, a reason and a bead id, and the count is
 * checked in BOTH directions. Too many is a new violation; too few is a stale
 * exemption, which is how a list like this rots into a permission slip — the design
 * says the count may only shrink, so shrinking it is part of the fix that shrank it.
 */
const TYPE_EXEMPTIONS = [
  {
    file: 'src/style.css',
    value: '11px',
    count: 4,
    bead: 'nocx-pp3y.2',
    reason:
      'the chrome register the scale does not have: item meta, the tab bar, the vertical strip, the editor chrome',
  },
  {
    file: 'src/style.css',
    value: '14px',
    count: 5,
    bead: 'nocx-pp3y.2',
    reason:
      'terminal text in the DOM. xterm draws the live screen at FONT_SIZE = 13, so these five are also 1px out from the canvas showing the same content — a defect to decide on a running page, not to round',
  },
  {
    file: 'src/styles/components/badge.css',
    value: '10px',
    count: 1,
    bead: 'nocx-pp3y.2',
    reason: 'the smallest register; no token is this size and inventing one is a scale decision',
  },
  {
    file: 'src/styles/components/button.css',
    value: '11px',
    count: 1,
    bead: 'nocx-pp3y.2',
    reason: "data-size='sm' — the chrome register, same decision as style.css's 11px",
  },
  {
    file: 'src/styles/components/tab.css',
    value: '11px',
    count: 1,
    bead: 'nocx-pp3y.2',
    reason: 'the tab index pill — the chrome register',
  },
  {
    file: 'src/styles/components/icon-button.css',
    value: '16px',
    count: 1,
    bead: 'nocx-pp3y.2',
    reason:
      "data-size='sm' sizes the '×' glyph rather than type; if it moves it becomes an icon-size declaration, not a font-size token",
  },
  {
    file: 'src/styles/surfaces/settings.css',
    value: '10px',
    count: 2,
    bead: 'nocx-pp3y.2',
    reason: 'the settings badge and breadcrumb — the smallest register',
  },
  {
    file: 'src/styles/surfaces/settings.css',
    value: '11px',
    count: 1,
    bead: 'nocx-pp3y.2',
    reason: 'the settings error line — the chrome register',
  },
  {
    file: 'src/styles/surfaces/export.css',
    value: '11px',
    count: 1,
    bead: 'nocx-pp3y.2',
    reason: 'the backup details block — the chrome register',
  },
  {
    file: 'src/styles/surfaces/update-notice.css',
    value: '10px',
    count: 1,
    bead: 'nocx-pp3y.2',
    reason: 'the update notice — the smallest register',
  },
  {
    // Fixture entry, and the only one that is deliberately WRONG. The fixture file has
    // one occurrence and this allows two, so the "count may only shrink" half of the
    // rule has something to fire on — otherwise that half would ship unwatched, which
    // is the failure mode this whole gate family exists to prevent.
    file: 'lint-fixtures/css-integrity-fixture/styles/surfaces/fixture-surface.css',
    value: '9px',
    count: 2,
    bead: 'nocx-zhjx',
    reason: 'fixture: proves a stale exemption is reported rather than silently allowed',
  },
]

/** px font-sizes and non-token font-families in one file. */
function findUntokenisedType(ast) {
  const hits = []
  css.walk(ast, {
    visit: 'Declaration',
    enter(node) {
      const value = css.generate(node.value).trim()
      if (node.property === 'font-size' && /(^|[^-\w])\d+(\.\d+)?px$/.test(value)) {
        hits.push({ property: 'font-size', value, line: node.loc?.start.line ?? 0 })
        return
      }
      if (node.property === 'font-family' && !value.includes('var(') && value !== 'inherit') {
        hits.push({ property: 'font-family', value, line: node.loc?.start.line ?? 0 })
      }
    },
  })
  return hits
}

/**
 * Rule 6 — the ancestor scope is gone and must stay gone.
 *
 * Keyed on the parsed SELECTOR rather than on the text, because this file's own
 * header explains the escaped-dot rule using `.kit-scope` as its example: a
 * literal-string ban would make the checker a violation of itself. Comments and
 * documentation are deliberately out of scope.
 */
function findKitScopeSelectors(ast) {
  const hits = []
  css.walk(ast, {
    visit: 'ClassSelector',
    enter(node) {
      if (node.name === 'kit-scope') {
        hits.push({ selector: `.${node.name}`, line: node.loc?.start.line ?? 0 })
      }
    },
  })
  return hits
}

export function checkCSSIntegrity({ entry, stylesDir, uiDir }) {
  const violations = []
  const entryAbs = resolve(entry)
  const stylesAbs = resolve(stylesDir)
  const rel = (p) => relative(PROJECT_ROOT, resolve(p))

  // Rule 3 needs to know what a kit identity is, and the only honest source is the
  // components' own JSX. An empty set is not "nothing to check" — it means the scan
  // found no directory, which would silently disable the rule, so say so instead.
  const uiAbs = uiDir ? resolve(uiDir) : resolve(stylesAbs, '..', 'ui')
  const { byClass } = scanKitIdentities(uiAbs)
  const kitIdentities = new Set(byClass.keys())
  if (kitIdentities.size === 0) {
    violations.push({
      rule: 'kit-identities-empty',
      file: rel(uiAbs),
      line: 0,
      detail:
        'the AST scan found no kit identities — rule 3 cannot run, and silence here would read as a pass',
    })
  }

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
  // Rule 7 counts per (file, value) so the exemption list can be checked in both
  // directions once every file has been read.
  const typeHits = new Map()

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

    // Rule 6 — `.kit-scope` is gone and must stay gone. The ban is on the SELECTOR,
    // not on the string: this checker's own header documents the escaped-dot rule
    // using `.kit-scope` as its example, so a literal-text gate would fail on its own
    // source. Prose in comments is out of scope by design.
    for (const hit of findKitScopeSelectors(ast)) {
      violations.push({
        rule: 'kit-scope-selector',
        file: rel(file),
        line: hit.line,
        detail: `\`${hit.selector}\` keys appearance off an ancestor the components never render — that contract was removed (nocx-pnbd)`,
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

    // Rule 3 applies everywhere the kit's own layer is not: `styles/components/` is
    // where a component's paint belongs, and `base.css` is the application layer that
    // owns the focus ring and the Page height/gutter chain (§3.2, §3.8).
    const inKitLayer =
      resolve(file).startsWith(resolve(stylesAbs, 'components')) ||
      resolve(file) === resolve(stylesAbs, 'base.css')
    if (!inKitLayer) {
      for (const hit of findSurfacePaintingKit(ast, kitIdentities)) {
        violations.push({
          rule: 'surface-paints-kit',
          file: rel(file),
          line: hit.line,
          detail: `\`${hit.selector}\` ${hit.detail}`,
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

    // Rule 7 — the token layer declares the scale; everything else reads it. `themes/`
    // and `tokens.css` ARE that layer.
    const inTokenLayer =
      resolve(file) === resolve(stylesAbs, 'tokens.css') ||
      resolve(file).startsWith(resolve(stylesAbs, 'themes'))
    if (!inTokenLayer) {
      for (const hit of findUntokenisedType(ast)) {
        const key = `${rel(file)} ${hit.value}`
        const prev = typeHits.get(key) ?? { file: rel(file), ...hit, count: 0, lines: [] }
        prev.count += 1
        prev.lines.push(hit.line)
        typeHits.set(key, prev)
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

  // ── untokenised-type (needs every file's count before the list can be judged) ──
  const exemptionsUsed = new Set()
  for (const hit of typeHits.values()) {
    const exemption = TYPE_EXEMPTIONS.find(
      (e) => `frontend/${e.file}` === hit.file && e.value === hit.value,
    )
    if (!exemption) {
      violations.push({
        rule: 'untokenised-type',
        file: hit.file,
        line: hit.lines[0],
        detail: `${hit.property}: ${hit.value} (${hit.count}×) bypasses the token layer — use a token, or add an exemption naming a file, a reason and a bead id`,
      })
      continue
    }
    exemptionsUsed.add(`${exemption.file} ${exemption.value}`)
    if (hit.count > exemption.count) {
      violations.push({
        rule: 'untokenised-type',
        file: hit.file,
        line: hit.lines[exemption.count] ?? hit.lines[0],
        detail: `${hit.count} occurrences of ${hit.value}, but the exemption (${exemption.bead}) allows ${exemption.count} — an exemption's count may only shrink`,
      })
    } else if (hit.count < exemption.count) {
      violations.push({
        rule: 'untokenised-type',
        file: hit.file,
        line: hit.lines[0],
        detail: `${hit.count} occurrence(s) of ${hit.value} left but the exemption (${exemption.bead}) still allows ${exemption.count} — lower it, or the list becomes a permission slip`,
      })
    }
  }
  // An exemption for a file this run did not scan is not stale — it belongs to a
  // different tree. The app run and the fixture run share one list, and each is only
  // answerable for the entries inside the tree it was pointed at.
  for (const e of TYPE_EXEMPTIONS) {
    if (exemptionsUsed.has(`${e.file} ${e.value}`)) continue
    const abs = resolve(FRONTEND_DIR, e.file)
    if (!abs.startsWith(stylesAbs) && abs !== entryAbs) continue
    violations.push({
      rule: 'untokenised-type',
      file: `frontend/${e.file}`,
      line: 0,
      detail: `the exemption for ${e.value} (${e.bead}) has nothing left to exempt — delete it`,
    })
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
  // Rule 3's identity set comes from the components' JSX. Defaults to the sibling of
  // the styles directory, which is `src/ui` for the app and the fixture's own `ui/`
  // for the fixture.
  const uiDir = arg('ui', resolve(stylesDir, '..', 'ui'))

  const violations = checkCSSIntegrity({ entry, stylesDir, uiDir })

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
