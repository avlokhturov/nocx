import { defineConfig } from 'vitest/config'

/**
 * Vitest config for the lint-fixtures checker tests.
 *
 * The repo's vitest.config.ts restricts `include` to src test files only,
 * which is right for application tests but excludes checker tests that live
 * beside their scripts. This config gives vitest exactly the one file:
 *
 *   ./node_modules/.bin/vitest run --config lint-fixtures/vitest.config.two-owners.mjs
 *
 * Run from frontend/. No solid plugin needed: the scanner is pure node.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lint-fixtures/check-two-owners.test.mjs'],
  },
})
