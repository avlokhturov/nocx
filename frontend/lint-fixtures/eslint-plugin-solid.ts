// Negative fixture for eslint-plugin-solid — plain TypeScript variant.
//
// This file intentionally contains prohibited patterns that fire in plain .ts
// (no JSX). It MUST produce lint errors. If the gate goes green on this file,
// a rule has silently regressed for .ts files, which is the format of the
// next epic deliverable (a Solid store).
//
// Excluded from tsconfig include and from build — do not type-check or bundle.

/* eslint-disable @typescript-eslint/no-unused-vars */

import { createEffect, createSignal } from 'solid-js'

// Rule: solid/no-react-deps — React-style dependency arrays are invalid in Solid
function createEffectWithDeps() {
  const [count] = createSignal(0)
  createEffect(() => {
    void count()
  }, []) // eslint-disable-line @typescript-eslint/no-unsafe-argument
}

// Rule: solid/reactivity — reading a signal inside a plain callback (no
// tracking scope) is a reactivity violation
function readsSignalOutsideTrackingScope() {
  const [value] = createSignal('hello')
  const fn = () => value()
  fn()
}

// Export so TypeScript treats this as a module
export const _unused = 0
