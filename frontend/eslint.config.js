// ESLint flat config — the frontend's golangci-lint (AGENTS.md: Go and
// TypeScript are held to the same bar). Type-checked rules are on: without the
// type information most of what golangci-lint catches on the Go side has no
// TypeScript equivalent. Formatting is prettier's job — eslint-config-prettier
// switches off every stylistic rule that would fight it.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import solid from 'eslint-plugin-solid'

export default tseslint.config(
  // lint-fixtures/ holds the negative fixtures for eslint-plugin-solid: files
  // whose whole purpose is to fail lint. They are excluded here and linted
  // explicitly by lint-fixtures/gate.sh with --no-ignore, which asserts that
  // each required rule fires.
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
  prettier,
)
