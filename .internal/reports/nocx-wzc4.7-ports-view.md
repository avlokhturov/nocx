# Report — nocx-wzc4.7: Ports belongs in the activity bar

## What changed

Ports is now a **sidebar view** with an activity-bar icon (PlugIcon); the palette
item and the tab surface are gone. "Integrate this shell" stays in the palette.

### Contract extension (the brief asked for this in the report)

The `SidebarViewDescriptor` contract was missing the two things the panel needs,
so the contract grew instead of the panel bending:

- `SidebarViewProps` (`visible: () => boolean`, `activeProfileId: () => string | null`)
  — every view now receives reactive view props from the shell. `view` is
  `Component<SidebarViewProps>` (was zero-prop `Component`).
- `SidebarHandle.revealView(viewId)` — reveal-or-focus from outside the sidebar
  (the chord). Unknown ids are a no-op (guarding this caught a real corruption:
  `setActiveView` happily activates a view that is not registered, orphaning the
  panel — the guard test asserts the no-op).
- `mountSidebar(bar, panel, views, actions, storage?, getActiveProfileId?)` — the
  composition root supplies the reactive active-profile accessor; the sidebar
  forwards it to every view.

The reactive active-tab source did not exist: `TabManager` has no activation
notification, so `tabs.ts` gained one optional `onActiveTabChange` callback fired
from `activate()` (the single funnel for activation changes). `main.tsx` feeds a
Solid signal from it. No polling, no capture-at-open.

### Files

- `frontend/src/sidebar.tsx` — descriptor/view-props/handle contract, props routed
  through PanelRoot/ActiveView, `revealView`.
- `frontend/src/tabs.ts` — `onActiveTabChange?: () => void` (+ one call site).
- `frontend/src/ports.tsx` — `PortsContent` (tab surface) deleted. `PortsPanel` now
  takes a reactive `profileId: () => string | null`: re-scopes on profile change
  (discards the previous connection's entire state), shows a "No active connection"
  empty state for null (local tab — never a stale host), syncs the backend's
  per-profile `visible` flag (retiring the previous profile on re-scope), and
  guards every async response against a mid-flight re-scope (a late status for
  profile A can no longer paint over profile B). Dropped the `Page`/`PageBody` tab
  chrome — the `ui-sidebar-view__body` is the scroll container; the Pause/Retry
  controls row now sits at the top of the body Stack (kit components only).
- `frontend/src/main.tsx` — ports view descriptor (icon, view wiring), reactive
  profile signal, chord `Ctrl/Cmd+Shift+O` → `sidebar.revealView('ports')`,
  `__ports__` removed from `ActionsQuickConnectProvider` args.
- `frontend/src/quick-connect.tsx` — `__ports__` item and `openPorts` param removed.
- `frontend/src/ports-surface.ts`, `frontend/src/ports-surface.test.tsx` — deleted
  (the tab-surface registration shape is gone; one route to the panel remains).
- Tests: `ports.test.tsx` (reactive prop + 5 new scope/visibility/poll/race tests),
  `sidebar.test.tsx` (+5 revealView/view-props tests), `quick-connect.test.tsx`
  (ports item gone, verb stays), new `frontend/src/ports-view.test.tsx` — the
  acceptance test: real TabManager + real mountSidebar, opens the view from the
  activity-bar button and asserts the ACTIVE tab's ports are on screen; switching
  SSH tabs re-scopes; local tab shows the no-connection state; collapsing the
  sidebar calls `visible(pid, false)` (sampling paused); the chord reveals and
  focuses.

## Test counts

- Before: 1843 (derived: 1850 after − 16 added + 9 removed; no baseline run was
  recorded).
- After: **1850 tests / 106 files, all passing** (`npm test -- --run`).
- Removed 9: ports-surface.test.tsx (6), PortsContent describe in ports.test.tsx
  (2), quick-connect "calls openPorts" (1).
- Added 16: ports-view.test.tsx (5), sidebar revealView/view-props (5),
  ports.test.tsx scope/visibility/poll/race (5), quick-connect "does not offer
  Ports" (1).

## Gates

From `frontend/`: `tsc --noEmit` clean, `eslint src/ --max-warnings 0` clean,
`prettier --check src/` clean, `npm test -- --run` → 1850/1850. No Go touched, so
`go build ./...` not run.

Two `eslint-disable solid/reactivity` blocks are deliberate and commented: the
signal accessor is passed into `mountSidebar`, which consumes it reactively inside
the view's tracked scopes — the gate cannot see across that function boundary.

## Could not verify

- **No real-browser pass.** The panel-in-sidebar layout (dropped Page chrome, body
  Stack) was decided from the CSS contracts (`ui-sidebar-view__body` owns scroll;
  Page owns `.surface-host` tab layout), not from a live stand. The owner's
  glance-and-watch workflow is covered by the reachability test at the jsdom
  level, not visually.
- Backend `ports.visible`/`ports.pause` semantics verified only through fakes, not
  a live backend.
- The chord is now intercepted unconditionally (like Ctrl/Cmd+Shift+P), so in a
  local terminal it no longer reaches the remote program — that is the intended
  reveal-or-focus tradeoff, but the remote-side effect was not exercised.
