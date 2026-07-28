#!/usr/bin/env node
/**
 * Kit identity scanner — derives the set of class names that kit components
 * own, by walking the **AST** of every .tsx file in the ui/ directory.
 *
 * Only class names that appear as **static** values on JSX `class=` /
 * `className=` / `classList=` attributes count. Comments, JSDoc, string
 * arguments to `querySelector`/`closest`/`matches`, and variant-lookup
 * object values are invisible to this scanner.
 *
 * Where a class expression cannot be statically resolved (e.g. a function
 * call returning a class string), the scanner reports it as undetermined
 * rather than guessing.
 *
 * §4 of "The kit owns its appearance — design" (2026-07-27):
 *   "Kit identity is derived by AST, not by prefix and not by regex."
 *   "The prefix is not the test."
 *
 * Returns `{ byClass, identities, undetermined }`:
 *   byClass      — Map<class → Set<file-basename>> (flat lookup for rules)
 *   identities   — Map<file-basename → { roots: string[], parts: string[] }>
 *   undetermined — Array<{ file, attrType, expressionType, sourceText }>
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from '@typescript-eslint/parser'

/**
 * Walk every descendant node of `node` and yield those matching `type`.
 */
function* walk(node, type) {
  if (!node || typeof node !== 'object') return
  if (node.type === type) yield node
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) yield* walk(c, type)
    } else if (child && typeof child.type === 'string') {
      yield* walk(child, type)
    }
  }
}

/**
 * Extract static class names from a class/className/classList attribute.
 *
 * Returns `{ static: string[], hasDynamic: boolean }`.
 * `hasDynamic` is true when the expression contains a non-static part
 * (a template interpolation, a function call, a prop read, etc.).
 */
function extractClasses(attr) {
  const attrName = attr.name?.name
  if (!attrName || !['class', 'className', 'classList'].includes(attrName)) {
    return { static: [], hasDynamic: false }
  }

  // classList={{ "foo": cond, "bar": cond }}
  if (attrName === 'classList') {
    return extractClassListKeys(attr)
  }

  if (!attr.value) {
    // boolean attribute — no value to extract
    return { static: [], hasDynamic: false }
  }

  // class="foo bar"
  if (attr.value.type === 'Literal' && typeof attr.value.value === 'string') {
    return { static: words(attr.value.value), hasDynamic: false }
  }

  // JSXExpressionContainer — class={expr}
  if (attr.value.type === 'JSXExpressionContainer') {
    return extractExpressionClasses(attr.value.expression)
  }

  return { static: [], hasDynamic: false }
}

function extractExpressionClasses(expr) {
  // TemplateLiteral: class={`foo ${x}`}
  if (expr.type === 'TemplateLiteral') {
    return extractQuasiClasses(expr)
  }

  // CallExpression on a template: class={`foo ${x}`.trim()}
  if (
    expr.type === 'CallExpression' &&
    expr.callee.type === 'MemberExpression' &&
    expr.callee.property.type === 'Identifier' &&
    expr.callee.property.name === 'trim'
  ) {
    const inner = expr.callee.object
    if (inner.type === 'TemplateLiteral') {
      return extractQuasiClasses(inner)
    }
  }

  // Any other expression cannot be statically resolved.
  // CallExpression — function returning a class string (labelClass(), variantClass())
  // ConditionalExpression, LogicalExpression, MemberExpression, Identifier — prop reads
  const hasDynamic =
    expr.type === 'CallExpression' ||
    expr.type === 'ConditionalExpression' ||
    expr.type === 'LogicalExpression' ||
    expr.type === 'MemberExpression' ||
    expr.type === 'Identifier'

  return { static: [], hasDynamic }
}

function extractQuasiClasses(tpl) {
  const names = []
  let hasDynamic = false
  for (const quasi of tpl.quasis) {
    const raw = quasi.value.raw || ''
    if (raw) {
      for (const w of words(raw)) {
        names.push(w)
      }
    }
  }
  // A template with actual expressions is partially dynamic
  if (tpl.expressions && tpl.expressions.length > 0) {
    hasDynamic = true
  }
  return { static: names, hasDynamic }
}

function extractClassListKeys(attr) {
  if (!attr.value || attr.value.type !== 'JSXExpressionContainer') {
    return { static: [], hasDynamic: false }
  }
  const expr = attr.value.expression
  if (expr.type !== 'ObjectExpression') {
    return { static: [], hasDynamic: false }
  }

  const names = []
  for (const prop of expr.properties) {
    if (prop.type !== 'Property') continue
    const key = prop.key
    let keyStr = null
    if (key.type === 'Literal' && typeof key.value === 'string') {
      keyStr = key.value
    } else if (key.type === 'Identifier') {
      keyStr = key.name
    }
    if (keyStr) names.push(keyStr)
  }
  return { static: names, hasDynamic: false }
}

/**
 * Split whitespace-delimited words. No prefix filter —
 * the spec says the prefix is not the test.
 */
function words(s) {
  return s.split(/\s+/).filter(Boolean)
}

/**
 * Source text snippet for the expression in a JSX attribute value.
 */
function expressionSnippet(expr) {
  if (expr.type === 'CallExpression') {
    const callee =
      expr.callee.type === 'Identifier'
        ? expr.callee.name
        : expr.callee.type === 'MemberExpression' && expr.callee.property.type === 'Identifier'
          ? `...${expr.callee.property.name}`
          : 'CallExpression'
    return `${callee}(...)`
  }
  if (expr.type === 'Identifier') return expr.name
  if (expr.type === 'MemberExpression' && expr.property.type === 'Identifier')
    return expr.property.name
  if (expr.type === 'ConditionalExpression') return 'ConditionalExpression'
  if (expr.type === 'LogicalExpression') return `LogicalExpression(${expr.operator})`
  return expr.type
}

/**
 * @param {string} uiDir — absolute path to `frontend/src/ui/`
 * @returns {{ byClass: Map<string, Set<string>>, identities: Map<string, { roots: string[], parts: string[] }>, undetermined: Array<{file:string,attrType:string,expressionType:string,sourceText:string}> }}
 */
/**
 * Classes a component happens to render that are nevertheless not identities.
 *
 * **Empty, and that is the finished state.** Its one entry was `kit-scope`, the styling
 * scope no component owned and every component's appearance depended on: `dialog.tsx`
 * rendered it on its own panel because a modal has no consumer to apply it, and a purely
 * mechanical AST rule read that single occurrence as "dialog.tsx owns kit-scope" — which
 * would then have made settings.tsx's own `<div class="kit-scope">` an inline-markup
 * violation. T15 (nocx-pnbd) deleted the class, so the exception has nothing left to
 * describe; rule 6 in `check-css-integrity.mjs` is what keeps the selector from coming
 * back, and this set staying empty is what says no component needs an exception.
 *
 * The set exists rather than being deleted because the derivation is over EVERY static
 * class, not over a `ui-` prefix (the design: "the prefix is not the test"). If a
 * component ever legitimately renders a class it does not own, this is where that gets
 * argued in writing instead of disappearing into a regex.
 */
const NOT_AN_IDENTITY = new Set()

export function scanKitIdentities(uiDir) {
  const byClass = new Map()
  const identities = new Map()
  const undetermined = []

  let entries
  try {
    entries = readdirSync(uiDir)
  } catch {
    return { byClass, identities, undetermined }
  }

  for (const entry of entries) {
    if (!entry.endsWith('.tsx') || entry.includes('.test.') || entry.includes('.spec.')) {
      continue
    }
    const absPath = resolve(uiDir, entry)
    let content
    try {
      content = readFileSync(absPath, 'utf-8')
    } catch {
      continue
    }

    // Skip files with no JSX at all
    if (!content.includes('<')) continue

    let ast
    try {
      ast = parse(content, {
        jsx: true,
        loc: false,
        range: false,
        errorRecovery: true,
      })
    } catch {
      continue
    }

    const fileRoots = new Set()
    const fileParts = new Set()

    for (const jsxEl of walk(ast, 'JSXOpeningElement')) {
      for (const attr of jsxEl.attributes) {
        if (attr.type !== 'JSXAttribute') continue

        const { static: names, hasDynamic } = extractClasses(attr)
        for (const cls of names) {
          if (NOT_AN_IDENTITY.has(cls)) continue
          if (!byClass.has(cls)) byClass.set(cls, new Set())
          byClass.get(cls).add(entry)

          if (cls.includes('__')) {
            fileParts.add(cls)
          } else {
            fileRoots.add(cls)
          }
        }

        // Report undetermined expressions
        const attrName = attr.name?.name
        if (attrName && ['class', 'className', 'classList'].includes(attrName)) {
          if (attr.value && attr.value.type === 'JSXExpressionContainer') {
            const expr = attr.value.expression
            const isCallTemplate =
              expr.type === 'CallExpression' &&
              expr.callee.type === 'MemberExpression' &&
              expr.callee.property.type === 'Identifier' &&
              expr.callee.property.name === 'trim' &&
              expr.callee.object.type === 'TemplateLiteral'

            // Undetermined: non-trivial expression that produced no static classes
            // but contains a dynamic component
            const nonTrivialDynamic = hasDynamic && names.length === 0

            // Also report partially-dynamic templates where the dynamic part
            // is the ONLY contributor (no static classes at all)
            const onlyDynamicInterpolation =
              expr.type === 'TemplateLiteral'
                ? names.length === 0 && expr.expressions?.length > 0
                : isCallTemplate
                  ? names.length === 0
                  : false

            if (nonTrivialDynamic || onlyDynamicInterpolation) {
              undetermined.push({
                file: entry,
                attrType: attrName,
                expressionType: expressionSnippet(expr),
                sourceText: content
                  .slice(expr.start ?? expr.range?.[0] ?? 0, expr.end ?? expr.range?.[1] ?? 0)
                  .substring(0, 80),
              })
            }
          }
        }
      }
    }

    if (fileRoots.size > 0 || fileParts.size > 0) {
      identities.set(entry, {
        roots: [...fileRoots].sort(),
        parts: [...fileParts].sort(),
      })
    }
  }

  return { byClass, identities, undetermined }
}

// ── CLI entry point (debug / fixture check) ──────────────────────────────────
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const uiDir = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(new URL('.', import.meta.url).pathname, 'src/ui')

  const { byClass, identities, undetermined } = scanKitIdentities(uiDir)

  console.log(
    JSON.stringify(
      {
        byClass: Object.fromEntries([...byClass.entries()].map(([k, v]) => [k, [...v].sort()])),
        identities: Object.fromEntries(
          [...identities.entries()].map(([k, v]) => [k, { roots: v.roots, parts: v.parts }]),
        ),
        undetermined,
      },
      null,
      2,
    ),
  )
}
