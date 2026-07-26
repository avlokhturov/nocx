import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

// Solid component tests need jsdom and the development/browser export
// condition. Without resolve.conditions, vitest resolves the server build
// of solid-js and reactivity misbehaves with no useful error. Existing
// non-Solid tests that use the // @vitest-environment jsdom pragma keep
// working unchanged.
// The solid plugin is registered so .tsx files import solid-js correctly.
export default defineConfig({
  plugins: [solid()],
  resolve: {
    conditions: ['development', 'browser'],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
