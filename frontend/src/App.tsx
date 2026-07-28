import type { Component } from 'solid-js'

/**
 * App — single Solid root that owns the shell layout and provides empty hosts
 * for every part of the imperative chrome:
 *
 *   #tabbar             — TabStripBase mounts its Solid fragment here (horizontal)
 *   #vertical-tabstrip  — TabStripBase mounts here (vertical)
 *   #activitybar        — mountSidebar renders SidebarSolid here
 *   #sidebar            — sidebar panel, managed by SidebarSolid
 *   #panes              — TabManager appends tab panes here (Solid MUST never
 *                         render children beneath, key, or remount this element)
 *
 * #tabbar stays present in both placements as the Wails drag region.
 * #workspace is a flex row containing #vertical-tabstrip and #body.
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
      <div id="tabbar" class="tabbar" />
      <div id="workspace">
        <div id="body">
          <div id="activitybar" />
          <div id="sidebar" />
          {/* The vertical tab strip lists the panes, so it sits next to them —
              inside #body, after the activity bar and the sidebar. It used to be
              a sibling of #body and therefore the leftmost thing in the window,
              pushing the activity bar (which is app-level chrome and belongs to
              the window edge) inward. Ordering it after #sidebar rather than
              immediately after the activity bar keeps it beside the panes when
              the sidebar opens, instead of wedged between the two. */}
          <div id="vertical-tabstrip" />
          <div id="panes" />
        </div>
      </div>
    </>
  )
}

export default App
