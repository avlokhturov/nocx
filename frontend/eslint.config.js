// ESLint flat config — the frontend's golangci-lint (AGENTS.md: Go and
// TypeScript are held to the same bar). Type-checked rules are on: without the
// type information most of what golangci-lint catches on the Go side has no
// TypeScript equivalent. Formatting is prettier's job — eslint-config-prettier
// switches off every stylistic rule that would fight it.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import solid from 'eslint-plugin-solid'
import { readFileSync, existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

// ─── Baseline loader (ADR-0014 §"The guard") ───────────────────────────────────────
// Per-violation baseline: each raw-control violation still present in application
// surfaces is enumerated by {file, id} where id is a hash of the node's source text.
// Stale baseline entries (violation no longer present) are harmless; only growth
// (a violation without a matching baseline entry) is an error.
const CONFIG_DIR = import.meta.dirname
const PROJECT_ROOT = resolve(CONFIG_DIR, '..')
const BASELINE_PATH = resolve(CONFIG_DIR, 'lint-fixtures/raw-controls-baseline.json')

/** Map of "${relativePath}:${hashId}" → entry for fast lookup. */
function loadBaseline() {
  try {
    if (!existsSync(BASELINE_PATH)) return new Map()
    const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
    const map = new Map()
    for (const v of raw.violations || []) {
      map.set(`${v.file}:${v.id}`, v)
    }
    return map
  } catch {
    return new Map()
  }
}

// Cache the baseline once; reloaded only on restart. Regeneration is a deliberate
// script, not a side effect of lint.
const baseline = loadBaseline()

// ─── Path-based exemption patterns (ADR-0014) ──────────────────────────────────────
// Application surfaces: files matching an exempt pattern are allowed to use raw
// controls / innerHTML. ESLint's own ignores (dist, lint-fixtures) handle the
// rest; this function only checks explicit ADR exemptions.
const EXEMPT_PATTERNS = [
  // The kit — native implementation details live here intentionally
  (rel) => rel.includes('/src/ui/'),

  // Terminal-owned files (ADR-0012 §"What is deliberately still imperative")
  (rel) => rel.endsWith('/src/tabs.ts'),
  (rel) => rel.endsWith('/src/tab-content.ts'),
  (rel) => rel.endsWith('/src/terminal-content.ts'),
  (rel) => rel.includes('/src/renderers/'),
  (rel) => rel.includes('/src/scrollback/'),
  (rel) => rel.endsWith('/src/editor.ts'),
  (rel) => rel.endsWith('/src/gutter.ts'),
  (rel) => /\/src\/input-[\w-]+\.ts$/.test(rel),
  (rel) => rel.endsWith('/src/dispatcher.ts'),
  (rel) => rel.endsWith('/src/command-ledger.ts'),
  (rel) => rel.endsWith('/src/clipboard.ts'),
  (rel) => rel.endsWith('/src/frame.ts'),
  (rel) => rel.endsWith('/src/submit.ts'),
  (rel) => rel.endsWith('/src/ipc.ts'),

  // Test files and test support
  (rel) => /\.(test|spec)\.(ts|tsx)$/.test(rel),
  (rel) => rel.includes('/test-support/'),
]

function isExempt(relPath) {
  return EXEMPT_PATTERNS.some((p) => p(relPath))
}

function hashNode(sourceCode, node) {
  const text = sourceCode.getText(node)
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

// ─── Custom rule: nocx/no-raw-controls ─────────────────────────────────────────────
// Rejects raw interactive elements and innerHTML in application surfaces.
// See ADR-0014 §"The guard" and brief nocx-vxqj.6.
const nocxPlugin = {
  rules: {
    'no-raw-controls': {
      meta: {
        type: 'suggestion',
        docs: {
          description:
            'Reject raw interactive elements (button, select, textarea, input) and innerHTML in application surfaces. Use kit components from ui/ instead (ADR-0014).',
        },
        messages: {
          rawControl: "Use a kit component from 'ui/' instead of raw <{{tag}}>. See ADR-0014.",
          rawInput:
            'Use a kit component from \'ui/\' instead of raw <input type="{{type}}">. See ADR-0014.',
          innerHTML:
            'Use a kit component instead of innerHTML assignment. Icons are components, not markup. See ADR-0014.',
        },
      },
      create(context) {
        const filename = context.filename ?? ''
        const rel = relative(PROJECT_ROOT, filename)

        if (isExempt(rel)) return {}

        const sourceCode = context.sourceCode

        // Raw HTML tags that must use kit components
        const RAW_TAGS = new Set(['button', 'select', 'textarea'])

        // Input types that must use kit components
        const RAW_INPUT_TYPES = new Set(['checkbox', 'radio', 'text', 'password', 'search'])

        function isBaselined(id) {
          // NOCX_BASELINE_UPDATE bypasses the baseline so the generator sees
          // every violation and can produce a complete baseline file.
          if (globalThis.process.env.NOCX_BASELINE_UPDATE) return false
          return baseline.has(`${rel}:${id}`)
        }

        function checkJSX(node) {
          const tagName = node.name.type === 'JSXIdentifier' ? node.name.name : null
          if (!tagName) return

          if (RAW_TAGS.has(tagName)) {
            const id = hashNode(sourceCode, node)
            if (!isBaselined(id)) {
              context.report({
                node,
                messageId: 'rawControl',
                data: { tag: tagName },
              })
            }
            return
          }

          if (tagName === 'input') {
            const typeAttr = node.attributes.find(
              (a) =>
                a.type === 'JSXAttribute' &&
                a.name.type === 'JSXIdentifier' &&
                a.name.name === 'type',
            )
            // No type attribute defaults to "text"
            const typeValue =
              typeAttr && typeAttr.value != null
                ? typeAttr.value.type === 'Literal'
                  ? String(typeAttr.value.value)
                  : typeAttr.value.type === 'StringLiteral'
                    ? typeAttr.value.value
                    : 'text'
                : 'text'

            if (RAW_INPUT_TYPES.has(typeValue)) {
              const id = hashNode(sourceCode, node)
              if (!isBaselined(id)) {
                context.report({
                  node,
                  messageId: 'rawInput',
                  data: { type: typeValue },
                })
              }
            }
          }
        }

        // innerHTML assignment: x.innerHTML = y
        function checkInnerHTML(node) {
          if (
            node.type === 'AssignmentExpression' &&
            node.left.type === 'MemberExpression' &&
            node.left.property.type === 'Identifier' &&
            node.left.property.name === 'innerHTML'
          ) {
            const id = hashNode(sourceCode, node)
            if (!isBaselined(id)) {
              context.report({
                node,
                messageId: 'innerHTML',
              })
            }
          }
        }

        return {
          JSXOpeningElement: checkJSX,
          AssignmentExpression: checkInnerHTML,
        }
      },
    },
  },
}

// ─── Config export ─────────────────────────────────────────────────────────────────
export default tseslint.config(
  // lint-fixtures/ holds the negative fixtures for eslint-plugin-solid and the
  // nocx/no-raw-controls fixture. They are excluded here and linted explicitly
  // by lint-fixtures/gate.sh with --no-ignore, which asserts each required rule fires.
  { ignores: ['dist/**', 'wailsjs/**', 'lint-fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Both projects: tsconfig.json owns src/, tsconfig.node.json owns the
        // Vite config. A file in neither is a file nobody type-checks.
        project: ['./tsconfig.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Config files are checked by tsconfig.node.json and run in Node, not the
    // browser; they need no type-aware linting of their own.
    files: ['*.config.js', '*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Fixture files are outside tsconfig (not in src/) — disable type-checked
  // rules but keep Solid lint rules.
  {
    files: ['lint-fixtures/**'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // SolidJS lint rules (ADR-0012 §3). Combined with the recommended base
  // from the plugin into a single files-restricted block so severity and
  // scope cannot drift.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.jsx'],
    extends: [solid.configs['flat/recommended']],
    rules: {
      'solid/no-destructure': 'error',
      'solid/reactivity': 'error',
      'solid/no-react-deps': 'error',
      'solid/no-react-specific-props': 'error',
      'solid/prefer-for': 'error',
      'solid/prefer-show': 'error',
      'solid/components-return-once': 'error',
    },
  },
  // nocx/no-raw-controls — rejects raw interactive elements and innerHTML in
  // application surfaces (ADR-0014 §"The guard"). Path exemptions and baseline
  // matching are handled inside the rule itself.
  {
    plugins: { nocx: nocxPlugin },
    rules: { 'nocx/no-raw-controls': 'error' },
  },
  prettier,
)
