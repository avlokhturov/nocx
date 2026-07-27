// Negative fixture for eslint-plugin-solid.
//
// This file intentionally contains every prohibited pattern the SolidJS lint
// rules catch. It MUST produce lint errors. If the gate goes green on this
// file, a rule has silently regressed.
//
// Excluded from tsconfig include and from build — do not type-check or bundle.

/* eslint-disable @typescript-eslint/no-unused-vars, prefer-const, no-console */
/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-misused-promises */

import { createEffect, createSignal } from 'solid-js'
import type { Component } from 'solid-js'

// Rule: solid/no-destructure — destructuring props breaks reactivity
function Destructure({ name }: { name: string }) {
  return <span>{name}</span>
}

// Rule: solid/no-react-deps — React-style dependency arrays
function ReactDeps() {
  const [count] = createSignal(0)
  createEffect(() => {
    void count
  }, []) // eslint-disable-line @typescript-eslint/no-unsafe-argument
}

// Rule: solid/no-react-specific-props — React-specific prop names
function ReactProps() {
  return (
    <div>
      <label htmlFor="x">Label</label>
      <input id="x" className="input" />
    </div>
  )
}

// Rule: solid/prefer-for — using .map() directly without <For>
function PreferFor(props: { items: string[] }) {
  return (
    <ul>
      {props.items.map((item) => (
        <li>{item}</li>
      ))}
    </ul>
  )
}

// Rule: solid/prefer-show — using && or ternary without <Show>
function PreferShow(props: { show: boolean; value: string }) {
  return <div>{props.show && <span>{props.value}</span>}</div>
}

// Rule: solid/components-return-once — multiple returns
function ComponentsReturnOnce(props: { flag: boolean; a: string; b: string }) {
  if (props.flag) {
    return <span>{props.a}</span>
  }
  return <span>{props.b}</span>
}

// Rule: solid/reactivity — reading prop inside a non-tracking callback
// (e.g. setTimeout) is a reactivity violation
function ReactivityIssue(props: { name: string }) {
  setTimeout(() => {
    console.log(props.name)
  }, 0)
  return <span>{props.name}</span>
}

// Export so TypeScript treats this as a module
export const _unused: Component<Record<string, never>> = () => null
