// Root ESLint flat config — covers files outside frontend/ (playwright.config.ts,
// e2e/**, spike/**). Non-type-checked: root files have no tsconfig project.
// frontend/ is deliberately left to frontend/eslint.config.js, which applies
// type-checked rules via its tsconfig references.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'graphify-out/**',
      '.beads/**',
      'dist/**',
      'build/**',
      '_bmad/**',
      '.agents/**',
      '.claude/**',
      '.opencode/**',
      'frontend/**',
      'spike/**',
      '*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['e2e/**/*.ts', 'playwright.config.ts', '*.ts', '*.mjs', '*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The .mjs files under e2e/ are Node scripts the gate runs, not browser
    // code. The .ts files here get `process` and `console` from @types/node;
    // a plain module gets them from nowhere, and no-undef is right to say so
    // until it is told what runtime this is.
    files: ['e2e/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  prettier,
)
