# The kit owns its appearance — design

- **Date:** 2026-07-27
- **Beads:** `nocx-zihu` (brainstorm), `nocx-pp3y` (the epic this replaces and widens)
- **Binding context:** ADR-0012 (SolidJS), ADR-0013 (plain CSS + semantic tokens),
  ADR-0014 (kit is nocx-owned, platform-first per primitive), AD-6 (terminal render
  state lives in xterm; the kit does not enter its subtree)
- **Reviewed by:** codex, adversarially, 2026-07-27. Its factual corrections and its
  ordering objection are folded in; where this document still departs from its advice
  it says so and why.

## 1. The defect

The kit's visual contract belongs to an ancestor class the kit's own components never
render.

Measured on `ed3a997`:

| Fact                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 42 **lines** of `kit.css` mention `.kit-scope`; some are multi-selector lists, so the selector count is higher | `grep -c kit-scope styles/components/kit.css` — a line count, not a selector count                                                                                                                                                                                                                                                             |
| `.kit-scope` has three production occurrences: two in a surface, one inside the kit itself                     | `settings.tsx:736,798`; `ui/dialog.tsx:127` on its own panel                                                                                                                                                                                                                                                                                   |
| Ten modules import from `ui/`; exactly one of them applies the scope                                           | `banner`, `connections`, `export-section`, `main`, `quick-connect`, `settings`, `sidebar`, `tab-strip`, `terminal-content`, `update-notice` — only `settings` scopes                                                                                                                                                                           |
| The **appearance-bearing element** is anonymous even where the wrapper is not                                  | `text-field.tsx:39` emits `.ui-textfield` on the wrapper but `:48` gives the `<input>` no class; `search-field.tsx:33` emits `.ui-search-field` but `:37` hands the `<input>` an arbitrary consumer class; `select.tsx:38` and `radio.tsx:23` emit only `props.class`; `checkbox.tsx:40,48` gives neither `<label>` nor `<input>` a base class |
| `PageSection` emits a `class` attribute but never a base class of its own                                      | `page-section.tsx:25` — `class={props.class ?? ''}`                                                                                                                                                                                                                                                                                            |
| `Button`'s `default` variant maps to `''`                                                                      | `button.tsx:23-30`; 70 call sites pass no variant                                                                                                                                                                                                                                                                                              |
| 16 of 83 kit call sites pass `class=` inward                                                                   | measured across `*.tsx` outside `ui/`                                                                                                                                                                                                                                                                                                          |
| **Three surface duplicates of the text input, on top of the kit's own**                                        | the kit's base at `kit.css:139`; duplicates at `style.css:155`, `export.css:200`, `export.css:237`                                                                                                                                                                                                                                             |
| 52 `font-size` values in px outside the token layer                                                            | `styles/` + `style.css`                                                                                                                                                                                                                                                                                                                        |
| `<Page>` has exactly one consumer                                                                              | `settings.tsx:732`                                                                                                                                                                                                                                                                                                                             |

The consequence is the one the owner named: a visual change costs five files, and
"change it in one place" is not technically possible.

### 1.1 The existing guard is satisfied and the kit is still bypassed

All three lint baselines — `raw-controls-baseline.json`, `color-literals-baseline.json`,
`inline-markup-baseline.json` — contain **zero** violations as of `ed3a997`. The guard
ADR-0014 specified has been met in full, and the shell bypasses the kit anyway. Three
holes, all verified:

1. **The kit used as a bare-element emitter.** `<Button class="tab-close">`,
   `<Button class="tab-add">`, `<Button class="tab-caret">` (`tab-strip.tsx:163,184,188`)
   pass no variant, so the class is empty and the whole appearance comes from
   `style.css`. "No raw `<button>`" is satisfied; the kit is defeated.
2. **The reserved namespace occupied from outside.** `export-section.tsx:337` passes
   `class="ui-export-btn"` into `Button`. The `ui-` prefix is reserved for classes a
   component renders, but `no-inline-markup` only knows classes components _do_ render,
   so a `ui-*` class nothing renders is invisible to it.
3. **Controls the raw-control rule does not name.** ADR-0014's rule lists `<button>`,
   `<select>`, `<textarea>` and `<input type=checkbox|radio>`. It does not list
   `input[type=file]` or `input[type=text]` — so `export-section.tsx:330,347` hold two
   raw file inputs, at zero baseline, styled solely by `kit.css:172-195` through the
   ancestor. §4 turns on this fact.

## 2. What the kit is for

The owner's definition, which this design implements literally:

> One style. A base page, and every other page behaves the same. One button, and every
> button everywhere is that button — change it in one place, it changes everywhere. No
> component yet, create one; component exists, reuse it. Need to customise, use props.

With one correction: **props must describe a closed, predefined vocabulary of
variation.** A prop admitting an arbitrary `class`, `style`, colour or spacing is the
same uncontrolled CSS routed through a component. `class` is not customisation; it is
an escape hatch, and it is being used as one.

## 3. Decisions

### 3.1 Identity on the element, variance on `data-*`

Every kit component always renders a stable base class naming itself, **on the element
that carries the appearance** — not merely on a wrapper. Variance is a typed `data-*`
attribute.

```tsx
<button class="ui-button" data-variant={props.variant ?? 'default'} />
<div class="ui-text-field">
  <input class="ui-text-field__input" data-size={props.size ?? 'md'} />
</div>
<label class="ui-checkbox" data-variant={props.variant ?? 'checkbox'}>
  <input class="ui-checkbox__control" />
</label>
```

A wrapper identity and a control identity are **different identities with different
duties**: `ui-checkbox` owns the row layout and the label, `ui-checkbox__control` owns
the box, its `:checked` mark and its disabled state. The gate in §3.7 must know both,
and must never infer one from the other.

Rules:

- Native states stay native: `:disabled`, `:checked`, `:focus-visible`, `:hover`.
- Semantic states key off ARIA: `[aria-invalid='true']`, `[aria-selected='true']`.
- `data-state` only where HTML and ARIA have no expression for it.
- `data-*` over modifier classes is a **discipline** choice, not a technical one: the
  DOM separates identity (`class`) from API state (`data-`), the CSS reads like the
  prop names, and hand-concatenated class strings disappear. Its cost: the attribute
  joins the kit's internal contract and a prop rename must move the CSS with it.
  TypeScript unions, not the attribute, give the type safety.

**`.kit-scope` is deleted.** Not widened to `:root`, not moved into `Page` — either
would preserve the false contract that a control looks right only in the right part of
the tree.

### 3.2 The focus ring leaves the components

`kit.css:6-12` declares the ring on `.kit-scope :focus-visible` plus bare
`button/input/select`. A visible focus indicator is an application-wide accessibility
invariant (WCAG 2.4.7), not a per-component detail: a surface that grows a new
focusable element must not have to remember to ask for one. Duplicating it per
component file multiplies the policy; enumerating every focusable identity makes the
policy a list that will fall out of date.

**The ring lives in `base.css`, on a bare `:focus-visible`.** Rule 4 does not reach it
because `base.css` is not component CSS. Components override offset or radius from
their own identity where the shape demands it, and nowhere else.

Deleting `.kit-scope` must not silently narrow which elements get a ring. §5 states the
focus matrix that has to be proven, and it is proven in a browser, not in jsdom — jsdom
computes no layout and has no `:focus-visible` heuristic, so a jsdom test asserting a
ring proves nothing.

Font inheritance is unaffected: `base.css:13-26` puts `font-family` on `body`, not on
`#app`, precisely so the `<dialog>` in the top layer inherits it.

### 3.3 CSS Modules stay rejected

ADR-0013 is not reopened. CSS Modules solve name collision; the defect here is
ownership. A consumer could still hand an imported class inward, surface CSS could
still reach a nested `input`, and variants would still need an API. Adopting them
would cost generated names, bundler coupling and a reversed ADR without addressing the
cause. Plain CSS suffices; the price is paid in contract, not technology.

### 3.4 `kit.css` splits per component

ADR-0013 §1 already specifies `components/` as one file per component. One 515-line
aggregate re-blurs the selector's owner.

| File               | Owns                                                        |
| ------------------ | ----------------------------------------------------------- |
| `button.css`       | `ui-button`                                                 |
| `icon-button.css`  | `ui-icon-button`                                            |
| `text-field.css`   | `ui-text-field`, `ui-text-field__input`                     |
| `search-field.css` | `ui-search-field`, `ui-search-field__input`, `__icon`       |
| `select.css`       | `ui-select`                                                 |
| `checkbox.css`     | `ui-checkbox`, `ui-checkbox__control`, the switch variant   |
| `radio.css`        | `ui-radio`, `ui-radio__control`                             |
| `file-input.css`   | `ui-file-input`, `::file-selector-button`                   |
| `field.css`        | `ui-field` and its label/description/error/horizontal parts |
| `section.css`      | `ui-section`                                                |
| `badge.css`        | `ui-badge`                                                  |
| `empty-state.css`  | `ui-empty-state`                                            |
| `toolbar.css`      | `ui-toolbar`                                                |
| `dialog.css`       | `nocx-dialog` and its panel; absorbs today's `overlay.css`  |
| `sidebar-view.css` | `ui-sidebar-view`                                           |
| `page.css`         | the `ui-page*` family — see below                           |

**The aggregation rule, stated because "one file per component" alone is ambiguous.**
A file owns one _identity family_: one root identity plus the `__part` identities only
that root renders. `Page`, `PageHeader`, `PageBody`, `PageRail`, `PageScroller` and
`PageSection` all emit `ui-page*` identities that exist only inside a `Page`, so they
are one family and one file. `SidebarView` is its own root and gets its own file even
though it is small. A component whose identity can appear without its parent is its own
family.

### 3.5 `FileInput` joins the kit

`kit.css:172-195` styles `input[type=file]` and its `::file-selector-button` through
the ancestor, and the only two consumers — `export-section.tsx:330,347` — are raw
elements the ADR-0014 rule never named. There is no component to move that CSS into,
so the split in §3.4 has nowhere to put it and step 1 would orphan it.

`FileInput` is added with `accept`, `onChange`, `disabled`, `ariaLabel`, and it renders
`class="ui-file-input"`. The button's _text_ stays the platform's and untranslatable —
that is native behaviour and is not a reason to hand-roll the control.

### 3.6 `class` is removed from every kit component

Removed from: `Button`, `TextField`, `SearchField`, `Select`, `Checkbox`, `Radio`,
`Badge`, `EmptyState`, `FileInput`, `IconButton` — and, as of nocx-zhjx, from the
structural containers too: `Section`, `PageSection`, `Toolbar`. `Field` never had one.

**Amended.** This section originally kept `class` on the structural containers whose
purpose is to be embedded, bounded to layout and placement:

> A class passed to a structural container may only carry **layout and placement** —
> `margin`, `grid`/`flex` participation, `width`, `order`, `align-self`, `position`. It
> may not carry appearance: `background`, `border`, `border-radius`, `color`,
> `font-*`, `padding`, `box-shadow`, `appearance`, or any pseudo-element that draws.

That bound was to be enforced by rule 11's weak tier, tracing the statically-passed
class from the JSX to its own rules. **The weak tier was then refused** (§4, rule 11):
it fires on `.cm-credential-card` and `.st-export-backup-details`, which are ordinary
cards, and a rule that cannot tell a card from a re-skinned kit container is a rule
people route around. That left the bound written down and unchecked — the exact shape
of §1.1's finding, where a guard existed and the kit was bypassed anyway.

So the hole was closed instead of policed. Measured before removing the prop: across
the whole app, **one** call site passed a class to any structural container —
`export-section.tsx` handing `st-export-card` to a `PageSection` — and
`st-export-card` had no CSS rule at all. It was a test hook, and three assertions in
`export-section.behavior.test.ts` were its only readers; they now address the card by
the anchor id the component already sets for deep linking. A prop with no consumer and
no enforceable bound is not an extension point, and a type that refuses a class beats
a lint rule that cannot see it — the same argument that made rule 1 unnecessary as a
lint rule.

The `padding` question this raised is answered by removal rather than by definition.
The property list above calls `padding` appearance, which would have made several
placement-only references true violations by fiat; with no passthrough to classify,
the only remaining channel is a parent's own selector, which rule 3 permits (nocx-zeti)
and which names the parent rather than the component.

Instance positioning belongs to the parent:

```css
.cm-toolbar {
  display: flex;
  gap: var(--space-2);
}
.cm-toolbar > :last-child {
  margin-left: auto;
}
```

or to explicit composition — `<Toolbar start={…} end={…} />`.

A new prop requires at least two legitimate consumers or a stated system requirement.
`marginLeft={12}` is not a component prop.

The variant vocabulary after migration:

| Component    | Props                                                                |
| ------------ | -------------------------------------------------------------------- |
| `Button`     | `variant: 'default' \| 'primary' \| 'danger'`, `size: 'sm' \| 'md'`  |
| `IconButton` | `selected`, `size: 'sm' \| 'md'`, `tabIndex`, `ariaLabel` (required) |
| `TextField`  | `size`, plus the existing semantic props                             |
| `Checkbox`   | `variant: 'checkbox' \| 'switch'`                                    |
| `Badge`      | `tone: 'neutral' \| 'info' \| 'warning' \| 'danger'`                 |

`Button`'s `default` becomes a real neutral button — today's `secondary` appearance —
so `secondary` as a separate name disappears. `close` disappears into `IconButton`.

**Ordering caveat.** What `default` should look like cannot be settled while 70 of its
call sites are shell chrome moving to `IconButton`. `Button`'s prop surface is closed
_after_ the shell migrates.

### 3.7 Chrome: three categories, not two

> The kit owns repeatable semantics and the visual contract. The surface owns domain
> state, orchestration and composite behaviour.

- **`IconButton` joins the kit.** Genuinely repeated: tab close, tab add, tab caret,
  activity-bar items, dialog close, toolbar icon actions. Roving tabindex stays with
  the _group_; the primitive only accepts `tabIndex` and `selected`.
- **`Tab` is a feature component.** It carries `role=tab`, drag and reorder,
  middle-click close, activity and agent indicators, `aria-controls` and two
  orientations — a behavioural unit, not a styled button.
- **`QuickConnectRow` stays with quick-connect.** A generic `ListRow` arrives only when
  a second consumer does. Today there is none.

**Feature components are declared, not inferred.** Rule 10 needs an exact set, and
without a `features/` directory there is no directory to infer it from. The set lives
in `frontend/src/ui/feature-components.json`: a list of `{ file, identity, roles }`
entries, read by the ESLint config the same way the existing baselines are. Adding an
entry is a reviewable act; the file is not a baseline and does not have to shrink, but
each entry must name the composite contract it owns.

**No `frontend/src/features/` layer.** Codex recommended one; this design declines, and
its earlier justification was wrong and is withdrawn — ADR-0013 §1 governs the
structure of `styles/`, not of `frontend/src`, so it forbids nothing here. The real
reasons are that there is exactly one feature module today, a top-level layer created
for one occupant is speculative structure, and introducing an architectural layer is
the owner's decision rather than a migration's side effect. `Tab` lives beside
`tab-strip.tsx`, its CSS at `styles/components/tab.css`. If a second feature module
appears, the layer is worth its own ADR.

### 3.8 The page layer

`Page` has the right parts — header, optional rail, body, one scroller,
`scrollToElement` — and the wrong composition. Settings is the only `Page`;
Connections and Export are arbitrary subtrees inside its scroller, which is why
`connections.css:18,25` reaches through `:has(.cm-root) > .kit-scope` to reconfigure
Page's internals. Structural smell, not difficult CSS.

- The page registry carries a descriptor, not just `render()`:

  ```ts
  interface SettingsPageDescriptor {
    id: string
    title: string
    description?: string
    actions?: JSX.Element
    scrollMode: 'page' | 'contained'
    renderContent(): JSX.Element
  }
  ```

- `scrollMode: 'page'` — `PageScroller` owns vertical scroll.
  `scrollMode: 'contained'` — `Page` gives a bounded content area and the surface
  assigns its own scroll owners. Connections needs `contained`; it is an explicit
  closed mode, never `:has()` detection and never a `class` escape on `Page`.
- **No `Page` inside a `Page`.** The shared rail reaches each real page through a thin
  `SettingsPage` wrapper — composition, not a second visual component.

`Page` owns: filling the surface host, the flex/`min-height: 0` chain, one declared
scroll owner, `main`/region semantics and accessible name, header/description/actions,
the shared gutter and content measure, rail layout and its responsive rearrangement,
the programmatic scroll API, and focus placement after a page change.

`Page` does not own: settings filtering, profile selection, any list's roving tabindex,
Enter/Delete handling, section hotkeys, form state, or Connections' two-column panels.
`settings.tsx`'s root `onKeyDown` mixes page navigation with domain behaviour and must
be separated.

**Dialog lives outside `#app`** and must stay reachable by nothing but inheritance and
identity. Its typography, `color`, `font-family`, focus treatment and control
appearance may derive only from `body` inheritance, from token custom properties on
`document.documentElement`, or from kit identities — never from `#app`, `.ui-settings`
or `.kit-scope`. Theme tokens already inherit `html → body → host → dialog`, including
into the top layer; §5 requires the regression test that proves it still does.

## 4. Gates

The gate checks ownership direction, not a snapshot of file names. The worst possible
gate — "every class must be on a list" — breeds meaningless names and `disable`
comments and is explicitly rejected.

**Kit identity is derived by AST, not by prefix and not by regex.** The set is computed
from static `class` / `classList` literals on JSX elements inside `frontend/src/ui/**`,
distinguishing root identities from `__part` identities, and _excluding_ comments,
doc strings, `querySelector` arguments and variant-class tables. The existing
mechanism at `eslint.config.js:62` matches a regex over raw source and would sweep all
of those in; it is not fit to bind a rule and is replaced.

The prefix is not the test, because the prefix is already in use by surface classes no
component renders — `ui-settings-row`, `ui-settings-search`, `ui-settings-filter`,
`ui-settings-section-nav`, `ui-export-desc`. Those stay; renaming them is churn that
fixes nothing. (`ui-export-btn`, passed into `Button` at `export-section.tsx:337`, is a
different case and goes away with rule 1.)

1. **`class` on a closed kit component**, in any consumer — an ESLint rule resolving
   JSX elements through their `src/ui` import, not by tag name. The message names both
   exits: a wrapper for layout, a typed prop for repeated variation.
2. **Component identity tests**: every primitive asserts its base class, its
   appearance-bearing element's identity, and its prop → attribute matrix.
3. **CSS ownership**: `styles/components/<x>.css` may contain only selectors rooted at
   an identity of that component's family (§3.4). Surface CSS may not reference a kit
   identity.
4. **Bare-tag selectors** (`button`, `input[type=…]`, `label:has(input)`) are forbidden
   in component CSS; only identity-rooted selectors are allowed. `base.css` is exempt
   and is where the focus ring lives (§3.2).
5. **The raw-control allowlist stays at zero**, and its element list grows to name
   `input[type=file]` and `input[type=text|password|number|search]` — the omission that
   let two raw file inputs sit at a zero baseline (§1.1).
6. **`.kit-scope` is gone.** The done condition is precise, because a literal-string ban
   is unachievable: the string legitimately appears in `check-css-integrity.mjs:12,13,119`
   as prose explaining the escaped-dot rule. The ban is on **`kit-scope` as a class in
   JSX** and **`.kit-scope` as a selector in CSS**. Prose in comments and documentation
   is out of its scope — but `ui/README.md:106` and `dialog.tsx:124,172` describe the
   old contract and are updated as part of the work, not left to rot.
7. **Untokenised values**: `font-size` in px and `font-family` outside the token layer
   are errors. Not all `px` — a `1px` border and exact icon geometry are legitimate; the
   rule names its properties and its exemptions.
8. **Dependency direction**: `ui/**` may not import surfaces, features or application
   state. The reverse is allowed.
9. **Page ownership**: every registered route builds its `Page` through the shared
   frame, no nested `.ui-page`, exactly one scroll owner in `page` mode.
10. **Role impersonation.** Outside `ui/`, an element carrying a role a kit primitive
    already provides — `button`, `checkbox`, `radio`, `switch`, `textbox`, `searchbox`,
    `combobox` — is an error. Exempt: `ui/**`, the entries in `feature-components.json`,
    and the terminal-owned files already exempt under AD-6.

    **`listbox` and `option` are deliberately not in that list.** A quick-connect row is
    composite domain semantics; a native `<select>` does not replace an arbitrary list
    row, and forbidding the role would push the surface toward worse markup.

    **The handler heuristic is dropped, not narrowed.** An earlier draft also flagged an
    activation handler on a non-interactive element. Measured, it fires on three
    legitimate sites — the Settings root's delegated `onKeyDown` (`settings.tsx:731`),
    Quick Connect's container (`quick-connect.tsx:236`) and a propagation boundary
    (`connections.tsx:258`) — none of which impersonates a control. Distinguishing them
    needs a real focus/activation-contract analysis, which is `eslint-plugin-jsx-a11y`'s
    job and not a rule this repo should half-write. The architectural half — roles that
    duplicate a kit primitive — is ours and is what rule 10 keeps.

11. **No hand-rolled control CSS.** Two tiers, because one heuristic cannot serve both.

    **Always an error outside kit and declared-feature CSS**, since these have no
    non-control use: `appearance`, `::placeholder`, `::file-selector-button`,
    `::-webkit-inner-spin-button`, `::-webkit-outer-spin-button`,
    `::-webkit-search-decoration`, `:checked::after`.

    **Conditional**, and only when the selector provably addresses a forbidden target —
    a raw `button`/`input`/`select`, an impersonated role from rule 10, or a class
    traced from JSX into a closed kit primitive or a structural container (§3.6): the
    appearance property set — `background`, `border`, `border-radius`, `color`,
    `font-*`, `padding`, `box-shadow`.

    **The property triple alone proves nothing** and must never fire on its own.
    Measured false positives it would produce today: `.cm-credential-card`
    (`connections.css:52`) and `.st-export-backup-details` (`export.css:127`) are
    ordinary cards. Feature components legitimately draw their own hover, selected and
    focus states — that is what makes them feature components. If a selector cannot be
    tied to interactive DOM statically, rule 11 stays silent rather than guessing.

Rules 1, 5, 10 and 11 are what close the holes §1.1 measured. Every rule ships with a
fixture proving it fires, in the existing `lint-fixtures/` pattern. An exemption
requires a file, a reason and a bead id, and its count may only shrink.

## 5. What must be proven, and where

Identity tests do not prove appearance, and jsdom proves nothing about focus or layout.

- **In jsdom**: identity and `data-*` matrices, ARIA wiring, the page descriptor
  contract, no nested `.ui-page`.
- **In a browser (Playwright, via `cmd/devharness` — no Wails, no GTK, no display)**:
  - **The focus matrix.** Every one of `Button`, `IconButton`, `TextField`,
    `SearchField`, `Select`, `Checkbox`, `Radio`, `FileInput`, `Tab` and
    `QuickConnectRow` shows a visible ring on keyboard focus and does not show one
    after pointer activation. This is the regression `.kit-scope`'s deletion can cause
    silently.
  - **Tab / Shift+Tab order and roving tabindex** in the tab strip and the activity bar.
  - **Disabled appearance.** The focus matrix says nothing about `:disabled`, and every
    primitive currently gets it from one shared `.kit-scope` rule (`kit.css:212-219`)
    that is about to be split eight ways. Assert the resolved opacity and cursor per
    primitive.
  - **`FileInput`'s `::file-selector-button`.** Platform-drawn, easy to lose in the
    move out of the ancestor, and invisible to any identity test.
  - **Theme.** Open a `Dialog`, switch `data-theme` on `document.documentElement`, and
    assert its computed token-derived colours change without a remount.
  - **Scroll ownership.** In `page` mode exactly one element scrolls; in `contained`
    mode the surface's own owners do.
  - **`Page`'s declared duties** (§3.8), which jsdom cannot show: focus placement after
    a page change, and the rail's responsive rearrangement at the narrow breakpoint.

## 6. Migration

**One pass, no shims.** Instructed by the owner and consistent with AGENTS.md's
clean-only rule: no dual ownership at any point, no compatibility block, no moment when
a control is styled from two places.

### 6.1 The unit of atomicity is one primitive, not one layer

The first draft cut the work into layers — identity first, consumers later. That is
dual ownership by construction, and the review caught it: give `Button` its
`ui-button` appearance in an early step and leave `cm-primary` (`connections.tsx:636`),
`tab-add` (`tab-strip.tsx:184`), `ui-export-btn` (`export-section.tsx:337`),
`ui-settings-section-nav-link` (`settings.tsx:601`) and `update-apply-btn` styled in
surface CSS until a late one, and for the whole interval **both** are in the cascade.
The same holds for `SearchField`, whose input gains identity early while quick-connect
migrates late.

So a transaction is **one primitive, end to end**:

1. the component emits its identity on its appearance-bearing element, plus `data-*`;
2. its rules — already sitting in `styles/components/<x>.css` after transaction 1 —
   are rewritten from the ancestor to that identity;
3. **every consumer of that primitive migrates in the same commit**: `class=` removed
   at the call site, replaced by a variant prop or a parent wrapper; the surface CSS
   that styled the old class deleted;
4. its `class` prop is removed and its identity test lands;
5. the gate for that primitive is enabled.

At no instant is any control styled from two places. `.kit-scope` shrinks as its
selectors leave, and is deleted when the last one goes.

**A transaction is exactly one primitive.** Not two related ones, not a themed group —
otherwise §6.1 and the plan contradict each other, and the transaction stops being
reviewable as a single claim.

**The rules that span several primitives are decomposed first, or the first primitive
to move breaks the others.** Two exist: the focus ring (`kit.css:6-12`) and the
disabled treatment (`kit.css:212-219`), which addresses `input`, `select` and `button`
in one selector list. If `TextField` migrated and took that rule with it, `Select`
would lose its disabled appearance while still waiting its turn — a genuine
counter-example to the no-dual-ownership claim, in the opposite direction. Transaction
1 therefore splits both _before_ any primitive moves. Splitting one rule into N rules
is not dual ownership: every element still has exactly one owner.

**The slice is per primitive, not per HTML element type.** Cutting the disabled rule
into `input` / `select` / `button` is not enough — one `input` slice still spans
`TextField`, `SearchField`, `Checkbox`, `Radio` and `FileInput`, and the original
counter-example survives inside it. The primitives have no identity yet at transaction
1, but they do not need one: the type attribute already tells them apart, and that is
the slice key —

```css
.kit-scope input[type='text']:disabled,
.kit-scope input[type='number']:disabled,
.kit-scope input[type='password']:disabled { … }   /* TextField  */
.kit-scope input[type='search']:disabled { … }     /* SearchField */
.kit-scope input[type='checkbox']:disabled { … }   /* Checkbox, switch variant included */
.kit-scope input[type='radio']:disabled { … }      /* Radio      */
.kit-scope input[type='file']:disabled { … }       /* FileInput  */
.kit-scope select:disabled { … }                   /* Select     */
button.kit-scope:disabled { … }                    /* Button     */
```

Each later transaction carries away exactly its own line and rewrites it to its
identity.

**Transaction 1 also moves every primitive's existing rules into its own file,
unchanged and still ancestor-keyed, so that `kit.css` ends the transaction empty and is
deleted.** This looks like a detail and is the difference between a serial migration and
a parallel one. If each primitive transaction had to _remove its rules from `kit.css`_,
`kit.css` would be a file all thirteen of them write to, and they could only ever run
one at a time regardless of which surfaces they touch. Relocating the rules first — a
pure move, no rewriting, no behaviour change, trivially reviewable as a diff that only
changes line numbers — leaves each later transaction touching exactly its own `.tsx`,
its own `.css`, and its consumers. What remains serialised is then only the genuine
overlap between consumers, measured in §6.4.

**The `radio` line is easy to miss and must not be**, which is why it is written out
here. `Radio` has no rules of its own in `kit.css` and looks like it needs no slice —
but the catch-all `.kit-scope input:disabled` (`kit.css:213`) does reach it, and
`Radio` has two live consumers at `connections.tsx:357,517`. Omitting it would change
a real control's computed style inside the very transaction whose done condition is
"disabled appearance unchanged". The general rule: the slice list is derived from what
the catch-all _matches_, not from what the stylesheet names. `IconButton` is the one
exception that needs no slice — it does not exist until transaction 3 and is born with
its own.

Two identity selectors carrying the same declarations — `ui-text-field__input` and
`ui-search-field__input` will — is likewise fine. The declarations are token
references, not repeated magic numbers, so "change it in one place" still holds: the
place is the token.

**This serialises on shared surface files, and that is a real constraint, not a
detail.** `settings.tsx` is a consumer of `Button`, `TextField`, `Select`, `Checkbox`,
`SearchField` and `Badge`; `connections.tsx` of nearly as many. Primitive transactions
therefore run one at a time against those files. What genuinely parallelises is the
work that touches neither: the identity mechanism, each gate rule with its fixture, the
browser harness, and the documentation.

### 6.2 Order

| #   | Transaction                                                                                                                                                                                                                      | Done when                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | The identity-derivation mechanism and its fixtures (§4)                                                                                                                                                                          | the derived identity set is asserted against a fixture; the regex at `eslint.config.js:62` is gone                                      |
| 1   | **Decompose and relocate.** Focus ring to `base.css`; the disabled rule (`kit.css:212-219`) split into one slice **per primitive**, still ancestor-keyed; every primitive's rules then moved verbatim into its own file per §3.4 | `kit.css` no longer exists; no rule addresses more than one primitive; focus matrix and disabled appearance (§5) unchanged in a browser |
| 2   | `FileInput` — new; Export's two raw file inputs (`export-section.tsx:330,347`) adopt it; `kit.css:172-195` → `file-input.css`                                                                                                    | rule 5's widened element list passes at zero                                                                                            |
| 3   | `IconButton` — new; adopted by the activity bar, tab add/close/caret, dialog close                                                                                                                                               | no `<Button class=…>` remains in shell files                                                                                            |
| 4   | `TextField` — identity on the input; `style.css:155` and `export.css:200,237` deleted; all consumers migrated                                                                                                                    | one text-input implementation exists                                                                                                    |
| 5   | `SearchField`                                                                                                                                                                                                                    | —                                                                                                                                       |
| 6   | `Select`                                                                                                                                                                                                                         | —                                                                                                                                       |
| 7   | `Checkbox`, including the switch variant                                                                                                                                                                                         | —                                                                                                                                       |
| 8   | `Radio` — today it has no rules at all, so this is a new appearance rather than a move                                                                                                                                           | —                                                                                                                                       |
| 9   | `Badge`                                                                                                                                                                                                                          | —                                                                                                                                       |
| 10  | `EmptyState`                                                                                                                                                                                                                     | —                                                                                                                                       |
| 11  | `Field` — structural; `class` stays but becomes layout-only (§3.6)                                                                                                                                                               | rule 11's traced-class tier passes for it                                                                                               |
| 12  | `Section` — structural                                                                                                                                                                                                           | —                                                                                                                                       |
| 13  | `Toolbar` — structural                                                                                                                                                                                                           | —                                                                                                                                       |
| 14  | `Button` — last, because what `default` should look like is only knowable once the shell's 70 variant-less call sites have become `IconButton`                                                                                   | rule 1 enabled with no exemptions                                                                                                       |
| 15  | `.kit-scope` deleted: the two wrappers in `settings.tsx`, the panel in `dialog.tsx`, the `:has(.cm-root) > .kit-scope` chain in `connections.css`                                                                                | rule 6 enabled                                                                                                                          |
| 16  | Docs and comments describing the old contract: `ui/README.md:106`, `dialog.tsx:124,172`                                                                                                                                          | no document describes a scope that no longer exists                                                                                     |
| 17  | `Tab` extracted as a feature component with `tab.css` and a `feature-components.json` entry                                                                                                                                      | keyboard, drag, middle-click, indicator and ARIA tests pass in a browser                                                                |
| 18  | quick-connect, banners, update-notice                                                                                                                                                                                            | no surface selector addresses a kit identity; rules 3 and 10 enabled                                                                    |
| 19  | Real pages: descriptors, `scrollMode`, `SettingsPage` wrapper, `:has(.cm-root)` gone                                                                                                                                             | no nested `.ui-page`; one scroll owner per page; rule 9 enabled                                                                         |
| 20  | Legacy `style.css` collapsed; the remaining gates enabled                                                                                                                                                                        | every counter in §4 reads zero                                                                                                          |

Dependencies, as distinct from preference: 0 precedes everything that asserts an
identity; 1 precedes every primitive, because it is what makes a primitive's rules
separable; 3 precedes 17, because `Tab` consumes `IconButton`; 14 follows 3 for the
reason in its row; 15 follows 2–14, since only then is the ancestor unreferenced.
Everything else is ordered by risk, not by need. The tab strip is late by choice —
drag, active state, roving tabindex and status indicators make it the surface where a
still-settling contract is most expensive to get wrong.

### 6.3 What actually runs in parallel, measured

After transaction 1 the only shared files left are the consumer surfaces. Measured on
`d7ac36e` — every consumer of every primitive, outside `ui/`:

| Primitive     | Consumer surfaces                                                                        |
| ------------- | ---------------------------------------------------------------------------------------- |
| `Button`      | banner, connections, tab-strip, settings, update-notice, export-section, sidebar, dialog |
| `TextField`   | export-section, connections, settings                                                    |
| `Checkbox`    | connections, export-section, settings                                                    |
| `Select`      | connections, settings                                                                    |
| `SearchField` | quick-connect, settings                                                                  |
| `Field`       | connections, settings                                                                    |
| `FileInput`   | export-section                                                                           |
| `IconButton`  | sidebar, tab-strip, dialog                                                               |
| `Badge`       | settings                                                                                 |
| `Radio`       | connections                                                                              |
| `EmptyState`  | connections                                                                              |
| `Section`     | connections                                                                              |
| `Toolbar`     | connections                                                                              |

Two transactions may run concurrently exactly when their consumer sets are disjoint.
That yields one genuinely parallel wave — `FileInput` (export-section), `IconButton`
(shell files), `Badge` (settings) and one of the connections-only four — after which
the multi-surface primitives run one at a time, and the remaining connections-only
transactions queue behind each other.

**This is the honest ceiling, and it is low.** Four workers at the widest point, two or
three for most of the run. The primitives are not a fan-out; the fan-out is elsewhere:
transaction 0, the browser harness, and each gate rule with its fixture touch none of
these files and none of each other. Anyone planning worker waves should take the
parallelism from this table rather than from the number of transactions.

### 6.4 "Renders identically" is not a done condition

Each transaction proves its result by **computed style**, not by eye: for the primitive
it touches, assert the resolved `background`, `color`, `border`, `border-radius`,
`font-size` and `padding` before and after, at every variant and in both themes.
Screenshot comparison is acceptable where the shape rather than the values is the
point. "It looks the same" is not a check, and this migration is precisely the kind
that fails silently — every defect in §1 was valid CSS the browser accepted without a
word.

## 7. Out of scope

- A `frontend/src/features/` layer (§3.7) — separate decision, separate ADR.
- A `ListRow` primitive — no second consumer exists.
- Renaming the `ui-settings-*` / `ui-export-desc` surface classes (§4).
- Any change to token _values_: the contrast work is measured and done.
- The terminal subtree (AD-6) and xterm's own `FONT_FAMILY`.
- Reopening ADR-0013 or ADR-0014.
