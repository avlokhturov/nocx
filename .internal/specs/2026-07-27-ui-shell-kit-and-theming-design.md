# Design — the application shell: a VS Code-style sidebar, one UI kit, one token layer

- **Date:** 2026-07-27 (revised the same day after an adversarial review; §12 records what changed)
- **Session bead:** `nocx-5lbo`
- **Follows:** ADR-0012 (SolidJS as the application UI layer), `nocx-njrx` (closed)
- **Epics:** `nocx-82l9` (shell), `nocx-vxqj` (kit), `nocx-xrrl` (tokens), `nocx-imkb` (pages),
  `nocx-708q` (sidebar views), `nocx-ycet` (state)
- **Decisions that need their own ADR:** the kit foundation (§4) and the styling
  architecture (§5). Both are hard to reverse; neither is settled by ADR-0012.

## 1. Why this exists

The Solid migration landed the rendering model and stopped there. What it did not land is
the thing the migration was justified by: **component ownership**. Measured on `main` at
commit `347487b`:

- `ui/` is imported by exactly one surface — `connections.tsx`. `settings.tsx` and
  `export-section.tsx` still use raw `<input>`/`<select>`/`<button>` (11 and 13
  occurrences). The macOS system `<select>` in Settings is the visible result.
- `style.css` is one 2,285-line file with **232 hardcoded hex colours** (27 unique). It
  declares five custom properties, of which only two are global design tokens
  (`--nocx-ui`, `--nocx-mono`, both fonts); the other three (`--tab-bg`,
  `--wails-draggable`, `--default-contextmenu`) are local or platform properties. Themes
  (`nocx-8yg.6`) cannot be built on this.
- `createAppStore()` has exactly one production consumer, `mountSidebar` (`sidebar.tsx:218`),
  which uses only the `sidebar` slice. The `tabModel`, `settings`, `profiles` and `banner`
  slices are unreachable. Surfaces keep private `createSignal` calls instead — 9 in
  `settings.tsx`, 8 in `connections.tsx`, 25 in `export-section.tsx`, counted as
  `createSignal` call sites, not reactive slots. ADR-0012 §2 — "no second source of
  truth" — is not achieved.
- Three surfaces are still imperative in whole or in part (§7).
- Three user-visible defects ship today (§3).

The frontend has **578** `it`/`test` declarations. ADR-0012's "544 unit tests" is a
historical figure from the migration and is not the current count; the difference matters
because §7 changes what a large number of them assert.

The owner's requirements, stated 2026-07-27: one kit, reused rather than re-invented; one
base page that other pages are built on; all CSS in one place driven by variables, because
themes come next; and a sidebar that works like VS Code — one icon per view, with files,
git and more to come.

## 2. The shell

### 2.1 Activity bar: two zones, two types

```
┌──┬───────────────┬──────────────────────────┐
│▣ │ EXPLORER  ⋯   │                          │   ▣ views (top zone)
│⌥ │ ▾ nocx        │        panes             │   ⚙ actions (bottom zone)
│⑂ │   ▸ cmd       │                          │
│  │   ▸ docs      │                          │
│⚙ │               │                          │
└──┴───────────────┴──────────────────────────┘
```

**Top zone — views.** Rendered from a registry. Clicking toggles the panel and switches the
active view. Each view owns its own header title and header actions.

**Bottom zone — global actions.** The settings gear lives here, as in VS Code. An action
opens a tab and **never touches the panel**.

These are two different types rendered by two different components. This is the structural
fix for `nocx-rp2j` (cold start opens an empty panel): today `mountSidebar` takes
`panelViews` and `tabActions` as two arrays, merges them into one `SidebarItem` union
discriminated by `kind`, and the panel then has to remember not to render content for a
`kind: 'tab'` entry. Splitting the zones makes "an action with an empty panel"
unrepresentable rather than merely fixed.

### 2.2 The view registry

```ts
interface SidebarViewDescriptor {
  readonly id: string
  readonly title: string              // panel header, e.g. "EXPLORER"
  readonly icon: Component            // activity-bar icon — a component, never markup
  readonly view: Component            // panel body
  readonly actions?: Component        // per-view header actions (⋯, refresh, collapse-all)
  readonly order: number
}
```

Adding a Git view is one registration in the composition root plus one component: no edit
to `App.tsx`, the activity bar, or the panel. This is the "multi-view MECHANISM" that
`nocx-708q` asks for, delivered before any particular view. Planned views: **Explorer**
(`nocx-708q`), **Git**, **Servers/SSH** (`nocx-eab`). Order is data, not code.

The `Sessions` placeholder is deleted — it stood for nothing designed (`nocx-i74e`).

### 2.3 Icons

Icons today are inline SVG **strings** assigned through `innerHTML` (`sidebar.tsx:187-189`,
with the markup living in `main.tsx:229-248`). That stops being the model. `index.html`'s
CSP blocks inline script, so this is not currently exploitable, but arbitrary SVG markup is
still a poor component API: SVG carries links, external references, styles and animation.

- Icons are **TSX components** under `ui/icons/`, authored or generated at build time from
  reviewed assets.
- They use `currentColor` for `fill`/`stroke` so they follow the token that colours their
  container.
- No runtime SVG injection: a lint rule rejects `innerHTML` in app surfaces, and a test
  asserts no `<svg>` is produced from a string at runtime.

### 2.4 Where SSH lives

The SSH manager is not removed; its entry point changes. `docs/vision.md:91` names the
integrated SSH manager as one of four product pillars, so deleting it is not on the table.

- **Connections stops being a full-screen tab surface.** Its content — profiles, groups,
  credentials, Tabby import — becomes a **page inside Settings**, exactly as Tabby does it
  (`tabby-settings/src/components/profilesSettingsTab.component.*`; Tabby has no separate
  Connections screen at all).
- **Quick connect** is the `Servers` sidebar view: a host list where a click opens a tab.
- `SURFACE_CONNECTIONS` and its singleton leave `surface-registry.ts` — but only after the
  replacement route is proven reachable (§9, step 8a/8b).

### 2.5 Shell geometry

```
#app
├── #tabbar                    top drag/title bar (Wails drag region, always present)
└── #workspace                 horizontal row
    ├── #vertical-tabstrip     mount host for vertical tab placement
    └── #body
        ├── #activitybar
        ├── #sidebar
        └── #panes
```

`#workspace` and `#vertical-tabstrip` do not exist today, which is why vertical tab
placement is broken (§3.2).

## 3. The three defects, and why they are structural

### 3.1 Settings does not scroll

**Confirmed diagnosis.** `.pane` is `position:absolute; inset:0; display:flex;
flex-direction:column; overflow:hidden` (`style.css:872-883`). `SettingsContent.mount`
appends an **unclassed** `<div>` into the pane (`settings-content.ts:49-62`) and renders the
Solid component into it. That anonymous element has no flex or height constraint, so
`.st-content { flex:1; min-height:0; overflow-y:auto }` (`style.css:1684`) never receives a
bounded block size; the content grows and the pane clips it. `.pane-manager { overflow:auto }`
(`style.css:906`) does not rescue it: `Tab` sets only `className = 'pane'` (`tabs.ts:58`), so
no production pane ever carries that class.

**Structural fix:** the seam always creates a `.surface-host`, and `Page` owns the chain
below it under the concrete contract in §6.1 — every node in the chain, not just the two the
first draft named.

### 3.2 Vertical tab placement is broken

**Confirmed diagnosis.** `style.css:645-655` documents that the vertical strip "lives in its
own container alongside `#body`" while `#tabbar` stays a minimal top drag bar. That container
does not exist: `App.tsx:23-28` renders `#tabbar` then `#body`, and `main.tsx:162-163` hands
the same `bar` element (`#tabbar`) to both orientations, which `TabManager` mounts via
`tabStrip.mount(this.bar)` (`tabs.ts:330`, and again on replacement at `tabs.ts:433-434`).
A 240px-wide column is therefore mounted inside the top bar.

**Fix:** add `#workspace` / `#vertical-tabstrip` (§2.5); orientation selects the host;
`#tabbar` stays present as the Wails drag region in both placements.

### 3.3 UpdateNotice keeps a stale class

`showDownloading()`, `showPendingRestart()` and `showError()` each replace `className`
(`main.tsx:64`, `:72`, `:80`); `showAvailable()` (`main.tsx:43`) replaces content but never
restores the base class. After an error, the "update available" state renders with the
`error` class.

**Structural fix:** delete the vanilla class and render from a discriminated union, so class
and content derive from the same value:

```ts
type UpdateState =
  | { kind: 'hidden' }
  | { kind: 'available'; version: string; notesUrl: string }
  | { kind: 'downloading' }
  | { kind: 'pending'; version: string }
  | { kind: 'error'; message: string }
```

## 4. The component kit

**Decision, conditional on the spike in §4.1: one nocx-owned kit in `frontend/src/ui/`, with
Kobalte used internally for the primitives where accessibility is genuinely hard. Surfaces
never import Kobalte directly.**

| Written by us | Kobalte behind a wrapper |
|---|---|
| Button, TextField, SearchField, Checkbox, Field, Section, Toolbar, Badge, EmptyState, Toggle | Select, Dialog, Popover, Menu / context menu, Tooltip, Combobox |

Rationale, weighing the three options `nocx-vxqj.2` names:

- **Fully hand-rolled** keeps the dependency count at zero, but agents write nearly all code
  here and the parts they get subtly wrong are exactly the parts a headless library provides:
  focus restoration, typeahead, ARIA relationships, dismissal, keyboard operation of a custom
  listbox. A styled control that cannot be driven from the keyboard is a regression relative
  to the native `<select>` it replaces.
- **solid-ui / shadcn-for-Solid is rejected.** It ships generated components into the repo
  under another project's conventions and maintenance cadence; agents will fork the generated
  files per surface, which defeats "write once, reuse" — the exact goal of `nocx-vxqj`.
- **Kobalte behind local wrappers** is headless and Solid-native, and the wrapper keeps one
  nocx vocabulary and one replacement point. `nocx-vxqj.2`'s constraint ("must not smuggle in
  a framework") is satisfied: Solid is already the framework.

### 4.1 The ADR is gated on a measured spike, not on this argument

Nothing above is evidence. The repo has no Kobalte dependency and no measurement, so the ADR
must not be written until a spike reports:

- the exact `@kobalte/core` version, its publication date and maintenance status, and its
  declared peer range against `solid-js` 1.9.14;
- the **measured** gzip delta against the real production build for the six primitives named,
  reported as shared-core cost plus incremental per-primitive cost — "tree-shakable" is not a
  number;
- the portal behaviour in §4.2, exercised in a packaged webview.

If the spike fails on cost or on §4.2, the fallback is locally implemented controls plus
narrow accessibility utilities — not adopting the set blindly. ADR-0012's 25–35 KB budget for
framework + kit is the ceiling.

### 4.2 Portals must have a Wails contract before any overlay ships

Dialogs, menus, popovers, combobox lists and tooltips portal out of their subtree. In a Wails
webview that changes inherited properties, stacking, clipping, focus and event ownership. An
overlay portaled to `body` can escape a page's `--wails-draggable: no-drag` boundary and land
on a drag region, where clicks move the window instead of activating the control. Focus traps
must also coexist with xterm's hidden textarea and with editor focus restoration.

The wrappers own: the portal root element, the z-index layer scale, `--wails-draggable:
no-drag` on that root, the dismissal policy, and focus return to the invoker. Packaged
WKWebView and WebKitGTK tests open every overlay type from the title-bar region **and** from a
terminal-adjacent surface.

### 4.3 The guard lands with the migration it enforces

An ESLint rule rejects raw interactive elements (`<button>`, `<select>`, `<textarea>`,
`<input type=checkbox|radio>`) and direct `@kobalte/*` imports in app surfaces, with `ui/` and
terminal-owned files exempt.

It cannot be switched on at step 5: `settings.tsx` and `export-section.tsx` still hold 11 and
13 raw controls, which step 7 removes. So the guard ships with an **enumerated baseline
allowlist keyed by file and control**, which may only shrink, is asserted to shrink by CI, and
must be **empty** before `nocx-vxqj` closes. Whole-surface exemptions are not allowed — that
is how a baseline becomes permanent.

## 5. Styling and theming

**Decision: plain CSS with semantic custom properties, organised as a `styles/` directory.
No Tailwind, no CSS Modules.**

```
frontend/src/styles/
├── tokens.css          the vocabulary — names, and derivations that do not vary by theme
├── themes/
│   ├── tokyo-night.css  (the current palette, extracted from the 27 hex values)
│   └── …                further themes are new files, nothing else
├── base.css            reset, typography, shell layout
├── components/         one file per kit component
└── surfaces/           page- and view-specific rules that are genuinely not reusable
```

A theme is a file assigning values to token names, selected by `data-theme` on the root.

**Why not Tailwind.** Not bundle size — fit. Tailwind distributes visual decisions into long
class strings in JSX, which is the opposite of "all CSS in one place"; theme work then means
policing arbitrary values and duplicated utility combinations; and it doubles the review
surface of a migration that already has to convert 2,285 lines to tokens. Orca's token layer
(`src/renderer/src/assets/main.css`) is the part worth copying — semantic variables and
explicit theme assignment — not the utility framework around it.

**Why not CSS Modules.** They scope selectors but scatter CSS across component files, which
the owner explicitly does not want, and they contribute nothing to tokens or theme switching.

### 5.1 Token layers, including derived and state colours

Base semantic UI colours (`--color-canvas`, `--color-surface`, `--color-surface-raised`,
`--color-text`, `--color-text-muted`, `--color-border`, `--color-accent`, `--color-danger`),
control metrics (`--control-height-*`, `--control-radius`, `--space-*`), and terminal tokens
(`--terminal-background`, `--terminal-foreground`, `--terminal-cursor`,
`--terminal-selection`, `--terminal-ansi-*`).

Interaction states are **not** left to authors. Each theme also defines, or `tokens.css`
derives centrally and once: hover, active, selected, disabled, focus-ring, overlay/scrim and
translucent-selection variants. Neither `opacity` on a whole component nor an ad-hoc
`color-mix()` at the call site is an acceptable substitute — that is how two components end up
with different hover shades.

If derivation uses `color-mix()`, the ADR records the minimum WebKit version supported and a
fallback; if the floor is not met, states are explicit per-theme values instead.

### 5.2 The guard defines an allowed grammar, not a denylist

Rejecting `#hex`/`rgb()`/`hsl()` is not enough: named colours, `oklch()`, `lab()`, `color()`,
gradient stops, `box-shadow` colours, SVG presentation attributes and inline `style` all slip
through, and `color-mix(in srgb, var(--color-accent), red 20%)` launders a literal through a
token.

The check parses CSS declarations and permits, outside `themes/`, only: `var(--token)`,
`currentColor`, `transparent`, `inherit`, and `color-mix()` whose every colour operand is one
of those. It also scans JSX for `style={...}` colour properties and SVG `fill`/`stroke`
attributes. Violations fail the build.

### 5.3 Colours that do not come from CSS

Four paths escape a CSS-file scanner, and each gets a stated policy:

| Source | Policy |
|---|---|
| Settings values from Go | May carry a *token name*, never a literal, unless the setting is explicitly a user-chosen colour |
| xterm's injected stylesheet (`index.html:10-12` keeps `style-src 'unsafe-inline'` for it) | Owned by xterm; out of scope for the guard, in scope for the theme adapter (§5.4) |
| Serializer output (`scrollback/serializer.ts:37-65` emits generated `rgb(...)`) | Terminal **content** semantics — exempt (§5.5) |
| SVG assets | Reviewed at build time; `currentColor` where the icon should follow its container (§2.3) |

### 5.4 xterm reads the same tokens, and startup ordering is explicit

The terminal palette is currently a literal object at `renderers/xterm.ts:152`. It is replaced
by one adapter that resolves the `--terminal-*` properties and builds xterm's `ITheme`.

Reading resolved properties *at terminal creation* has a real race: if `data-theme` or its
stylesheet is applied after the first `getComputedStyle()`, the first terminal gets defaults
or empty strings and stays wrong until the next theme event. `document.fonts.ready`
(`xterm.ts:185`) does not order stylesheets. So:

- A **synchronous bootstrap theme resolver** runs before the Solid render and before any
  terminal is constructed: it applies `data-theme`, validates that every required custom
  property resolves to a non-empty value, and falls back atomically to the built-in theme if
  not.
- A concrete `ITheme` is passed into terminal construction — never read opportunistically
  afterwards.
- Subscription to theme changes is registered **before** construction, or reapplied
  immediately after registering, to close the fetch/subscribe race.

`applyTheme(theme)` is a **terminal-controller** operation, not a Solid effect. It sets
`term.options.theme` *and* performs whatever refresh or atlas invalidation xterm needs for the
new palette to appear without user interaction. ADR-0005's 42 ms WebKitGTK refresh pump stays
wholly inside the controller and is not driven from reactive state; a Linux/WebKitGTK test
asserts the new palette appears on a live terminal with no input.

### 5.5 Scrollback keeps its own conversion, but not its own palette

`scrollback/serializer.ts:11-49` owns a second ANSI table. ANSI 0–15 must come from the theme;
indices 16–255 and truecolor are **content**, and their algorithmic conversion stays.

One decision this design makes explicitly: frozen blocks are **snapshot-themed** — the active
palette is injected into serialization at capture time, so re-theming does not silently recolour
old output and diverge from what xterm showed when it was produced. Tests cover a theme change
before and after a block freezes.

## 6. Page and view composition

Solid has no component inheritance. "One base page that others are built on" is expressed as
composition, and the base owns the invariants that pages keep getting wrong.

### 6.1 The height contract, stated as selectors

`flex: 1` alone does not bound anything; WebKit is specifically sensitive to implicit flex
minimum sizes, which is why the current bug is invisible in jsdom and in some Chromium runs.
Every node in the chain is specified:

```css
#panes            { position: relative; min-height: 0; }
.pane             { position: absolute; inset: 0; display: flex; flex-direction: column;
                    overflow: hidden; }                       /* unchanged */
.surface-host     { display: flex; flex: 1 1 auto; min-width: 0; min-height: 0;
                    overflow: hidden; }
.ui-page          { display: flex; flex-direction: column; flex: 1 1 auto;
                    min-height: 0; overflow: hidden; }
.ui-page__header  { flex: 0 0 auto; }
.ui-page__body    { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0;
                    overflow: hidden; }
.ui-page__rail    { flex: 0 0 auto; min-height: 0; overflow-y: auto; }
.ui-page__scroll  { flex: 1 1 auto; min-height: 0; min-width: 0; overflow-y: auto; }
```

Both the normal and the narrow (stacked) layout are tested in packaged WebKitGTK, not only in
the browser harness.

### 6.2 Scroll ownership: two owners, named

The first draft claimed one scrolling node and then gave the rail `overflow:auto` — a
contradiction. The rule is:

- `PageScroller` is the **content** scroll owner. Every page has exactly one.
- `PageRail` may scroll **only** as a bounded rail, and only when its own content exceeds its
  height. At the narrow breakpoint the rail stacks above the content and does not scroll
  independently.
- No third scroll container. A test asserts that a page's subtree contains no other node with
  a computed `overflow` of `auto`/`scroll`, rail excepted.

Deep linking uses the scroller, not the document: `PageScroller` exposes
`scrollToElement(el)`, and `settings.tsx:369-380`'s `row.scrollIntoView()` — which scrolls
every scrollable ancestor, including ones we do not own — is replaced by scroller-relative
positioning.

This is an enforceable invariant, not a guarantee: portaled overlays and any future nested
`overflow` still have to be checked by the test above. "Cannot recur" was too strong.

### 6.3 One seam, not two

`settings-content.ts` and `connections-content.ts` are replaced by a generic `SolidTabContent`
that creates `.surface-host`, opens exactly one Solid root, forwards viewport changes, and
disposes exactly once. It never renders page chrome and never carries terminal behaviour.

### 6.4 The Settings page registry, and what stays generated

Settings is `Page + PageRail + PageScroller`, with the rail selecting sub-pages. The rail is
**not** simply generated from Go declarations any more, because Connections is not a setting.
So the rail is a typed registry of two kinds of entry:

```ts
type SettingsPage =
  | { kind: 'generated'; id: string; title: string }   // one page per Go-declared section
  | { kind: 'component'; id: string; title: string; page: Component }
```

The generated-screen invariant is preserved **inside** the generated pages and stated with that
boundary: adding a Go setting still costs zero frontend changes and appears in its section's
page. Adding an application page such as Connections is one registry entry — and is explicitly
*not* claimed to be free.

### 6.5 Keyboard and focus model

The shell currently has no stated focus model beyond the tab strip's roving tabindex, and every
new surface would invent one. Decided here, before the registry components are written:

- **Activity bar** is a `toolbar` with roving tabindex. Up/Down move between buttons, Home/End
  jump to the ends, Enter/Space activate. The views zone and the actions zone are one focus
  order but two groups (`aria-label` each).
- **Panel** — focus moves into the active view's body with the standard Tab order; the view's
  header actions precede the body. Collapsing the panel (`Cmd/Ctrl+B` or re-clicking the active
  view) returns focus to the activity-bar button that owns it.
- **Page** — rail is a `tablist`-shaped navigation with arrow-key movement and explicit
  activation (Enter/Space), so arrowing does not fire expensive page loads.
- **Overlays** trap focus while open and return it to the invoker on dismiss (§4.2).
- **Escape** closes the topmost overlay; with no overlay open in a terminal pane, Escape belongs
  to the terminal and the shell does not intercept it.
- Shell shortcuts must not shadow keys the terminal or the CodeMirror editor owns; conflicts are
  resolved in favour of the focused surface, and `nocx-2gf` owns the editor keymap.

## 7. Finishing the Solid migration

`nocx-njrx` is **not reopened** — an epic whose criterion has stopped being false once should
stay closed; reopening it destroys the meaning of the criterion. Instead ADR-0012's "As shipped"
section is corrected to describe what actually shipped, and the remaining work is `nocx-82l9`.

- **`tab-strip.tsx`** — Solid renders only the static wrapper; every tab button is built with
  `createElement` (`:96-131`), painted by hand (`paintButton`), reordered via
  `tabsContainer.innerHTML = ''` (`:217`), with roving tabindex managed manually. The file
  comment states the reason: "backward compatibility with existing DOM-level tests and e2e
  MutationObservers" — the tests are holding the implementation in place.
- **`sidebar.tsx`** — the activity bar is real Solid, but the panel (title element, per-view
  containers, `style.display` toggling) is built imperatively inside a `createEffect`
  (`:103-141`). Replaced wholesale by §2.
- **`UpdateNotice`** (`main.tsx:32-98`) — deleted, re-rendered from §3.3's union. `main.tsx`
  then really is the composition root and nothing else.

**The tab-strip step carries a DOM compatibility matrix**, written before the rewrite, because
unit tests and e2e specs depend on `.tabs-container`, `.tab-index`, stable node identity, focus,
ARIA linkage, and a `MutationObserver` in `e2e/tab-title.spec.ts:11-44`. The matrix states, per
selector: preserved, or deliberately changed and what replaces the assertion. Tab nodes are
keyed by tab id so `<For>` preserves identity across reorder. Every unit and e2e file that must
change lands in the same commit.

## 8. State ownership

The ownership table is written **first**, and lands before any surface is merged or moved
(§9). It is the deliverable `nocx-ycet` actually needs.

- **One store, created in the composition root**, holding *accepted shared* state: tab list and
  active tab, tab placement, active sidebar view and collapsed flag, selected theme, accepted
  settings revision and values.
- **Local to the surface**: edit drafts, validation messages, expanded cards, file-picker
  selections, request-busy flags. "One store" must not become "every transient control value in
  a global object".
- `mountSidebar`'s private `createAppStore()` (`sidebar.tsx:218`) goes away; the store is
  injected.
- Slices with no consumer after that are **deleted**, together with the tests that only prove
  unreachable APIs. Tests are not a reason to keep unreachable code (AGENTS.md, check 5).

**Persistence is versioned and single-homed.** Today the sidebar collapse flag is a raw
localStorage key `nocx.sidebar.collapsed` (`sidebar.tsx:19,97-100,221-233`) and tab placement is
a Go setting `tab.placement` (`main.tsx:152-208`). The design adds active view and selected
theme. Rules: Go settings stay authoritative for anything a user configures — the frontend store
mirrors, never re-persists, `tab.placement`; purely local UI state uses one versioned
localStorage record with a stated migration from the existing key and a defined default when
absent or unreadable.

## 9. Sequence

Each step lands and is verifiable on its own. Steps 1–4 are user-visible bug fixes and do not
wait for the kit.

| # | Step | Deletes |
|---|---|---|
| 1 | Correct ADR-0012 "As shipped"; add failing tests for §3.1–3.3 | nothing |
| 2 | `.surface-host` + generic `SolidTabContent` + the §6.1 selectors; migrate both seams | duplicated mount/dispose in the two `*-content.ts` |
| 3 | `#workspace` / `#vertical-tabstrip`; orientation picks its host; **update `e2e/tabs.spec.ts:57-78,122-143`, which currently assert `.tabstrip-vertical` on `#tabbar`, in the same commit** | the "every strip mounts into `bar`" assumption; CSS comments describing absent structure |
| 4 | `UpdateNotice` → Solid | the vanilla class at `main.tsx:32-98` |
| 5 | Kobalte spike (§4.1) → ADR: kit foundation; guard with a shrinking baseline (§4.3) | nothing |
| 6 | ADR: styling architecture (§5); `styles/` + tokens incl. state tokens; convert shell and existing kit; the §5.2 grammar check with its own baseline | hardcoded palette in converted selectors |
| 7 | State **ownership table** (§8) — decided before surfaces move | nothing |
| 8 | `Page` / `SidebarView` (§6.1–6.2); Settings page registry (§6.4); migrate Settings onto kit + Page | Settings-specific control CSS, raw markup |
| 9a | Connections **added** as a Settings sub-page; every current entry path and the `tm.newSSHTab()` connect callback exercised end-to-end | nothing |
| 9b | Only once 9a is green: remove the standalone surface | `SURFACE_CONNECTIONS`, `connections-content.ts`, `cm-*` rules |
| 10 | Export into the same page/section vocabulary | `st-export-*` duplication |
| 11 | Sidebar view registry; activity-bar zones; icons as components; delete Sessions | `mountSidebar`'s two-array API, imperative panel, Sessions placeholder, SVG-string icons |
| 12 | Finish `tab-strip.tsx` on `<For>` with the §7 compatibility matrix | imperative button construction and the tests that pinned its DOM shape |
| 13 | Store in the root per the step-7 table; delete dead slices; versioned persistence | unreachable models, their tests, sidebar's private store |
| 14 | Theme switching end-to-end, including the §5.4 bootstrap resolver and xterm | literal palettes at `renderers/xterm.ts:152` and the serializer's ANSI table |
| 15 | CSS consolidation sweep; set a CSS/bundle budget; both baselines from steps 5 and 6 must be empty | orphaned selectors, remaining literals, inline styles |

Two ordering rules the review corrected: the state ownership table moves **before** any surface
migration (step 7, not last), because moving Connections into Settings otherwise decides
mount persistence, draft lifetime and observer ownership by accident; and the Connections
deletion is split from its creation (9a/9b), so nothing is removed before its replacement is
proven reachable.

Explorer (`nocx-708q`), Git and Servers (`nocx-eab`) build on the registry and `SidebarView`
after step 11.

## 10. Risks and the checks that catch them

| Risk | Check that actually catches it |
|---|---|
| Broken height/scroll chain | WebKit e2e: open Settings in a short window, scroll to the last setting, assert visible. jsdom cannot see layout. |
| A second scroll container appears | test asserting no computed `overflow:auto/scroll` in a page subtree except the rail |
| Vertical strip mounted in the title bar | e2e bounding-box assertions: drag bar above workspace, strip left of `#body`, panes non-zero width |
| Wails drag region swallows clicks, incl. portaled overlays | packaged WebKitGTK/WKWebView smoke test opening every overlay from the title-bar region — Playwright does not implement Wails drag semantics |
| Stale update-notice class/content | unit test over every state→state transition, especially error→available |
| Tab identity or focus lost on reorder | component test asserting DOM node identity and focus survive reorder; keying by tab id |
| Roving tabindex / ARIA regression | component tests plus arrow/Home/End e2e in both orientations and in the activity bar |
| Solid remounts the xterm host | mount/dispose counters across activation, reorder, placement change, theme change |
| First terminal gets an unthemed palette | assertion that the bootstrap resolver ran and every `--terminal-*` resolved before construction |
| Theme change does not repaint on WebKitGTK | Linux packaged test: change theme, assert new palette on a live terminal with no input |
| Frozen scrollback recolours | test a theme change before and after a block freezes |
| Kobalte bundle creep | per-step production build recording raw/gzip delta against the 25–35 KB budget |
| An agent hand-rolls a control again | the ESLint guard (§4.3) with a baseline that only shrinks |
| A colour literal launders through `color-mix` or SVG | the grammar check (§5.2), including JSX and SVG attributes |
| "Central" state goes dead again | reachability test plus store contract tests with two real consumers |
| Persisted UI state lost on upgrade | migration test from the existing `nocx.sidebar.collapsed` key |
| Chromium green, WebKit broken | keep both projects; WebKit is the release-relevant result. ADR-0012:266 records a regression that 544 unit tests and all 20 Chromium specs missed. |

## 11. Explicitly out of scope

- File mutation in Explorer (rename, delete, drag-and-drop) — stays out per `nocx-708q`.
- Remote/SFTP browsing — `nocx-9le.5`.
- A published design-system package outside this repo.
- Light theme content: the token layer must *support* it; shipping a second palette is
  `nocx-8yg.6`'s call, not this design's.
- Localisation of the new chrome — `nocx-dej6`.

## 12. What the adversarial review changed

Reviewed by codex against the code on 2026-07-27; 5 blockers and 14 should-fix findings. The
corrections folded in above:

1. The kit ADR is gated on a measured spike (§4.1) instead of asserting Kobalte is right.
2. Portals get an explicit Wails contract before any overlay ships (§4.2).
3. The lint guard ships with a shrinking baseline rather than landing before the migration it
   enforces (§4.3).
4. "Only `PageScroller` scrolls" contradicted the rail's own `overflow:auto`; scroll ownership is
   now two named owners plus a test, and `scrollIntoView` is replaced (§6.2).
5. The height contract is stated as concrete selectors for every node, not two (§6.1).
6. The Settings rail is a typed registry; the generated-screen invariant is scoped to generated
   pages instead of being silently broken (§6.4).
7. The state ownership table moves before the surface migrations; Connections creation and
   deletion are split (§9, steps 7 and 9a/9b).
8. Step 3 must update the existing vertical-tab e2e assertions in the same commit; step 12
   carries a DOM compatibility matrix (§9, §7).
9. The colour guard defines an allowed grammar rather than a denylist, and covers JSX/SVG (§5.2).
10. Derived and state colours, non-CSS colour sources, the xterm startup race, ADR-0005's refresh
    pump and the serializer's palette all get stated policies (§5.1, §5.3, §5.4, §5.5).
11. A keyboard and focus model is specified (§6.5); icons become components, not markup strings
    (§2.3); persistence is versioned and single-homed (§8).
12. Corrected facts: `style.css` declares five custom properties of which two are design tokens
    (was "2"); the suite has 578 test declarations (ADR-0012's 544 is historical); "cannot
    recur" softened to an enforced invariant.
