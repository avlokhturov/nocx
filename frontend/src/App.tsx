import type { Component } from 'solid-js'

/**
 * App — single Solid root that owns the shell layout and provides empty hosts
 * for every part of the imperative chrome:
 *
 *   #tabbar         — TabStripBase mounts its Solid fragment here
 *   #activitybar    — mountSidebar renders SidebarSolid here
 *   #sidebar        — sidebar panel, managed by SidebarSolid
 *   #panes          — TabManager appends tab panes here (Solid MUST never
 *                     render children beneath, key, or remount this element)
 *
 * Per-tab surfaces (settings, connections, export) keep their own Solid roots
 * mounted into panes by the TabContent seam — converting those is not this
 * bead's scope.
 *
 * No reactive state: the shell skeleton is static. All lifecycle and wiring
 * lives in the imperative bootstrap in main.ts.
 */
const App: Component = () => {
  return (
    <>
      <div id="tabbar" />
      <div id="body">
        <div id="activitybar" />
        <div id="sidebar" />
        <div id="panes" />
      </div>
    </>
  )
}

export default App
