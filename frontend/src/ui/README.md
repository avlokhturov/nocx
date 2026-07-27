# UI Kit — `frontend/src/ui/`

One nocx vocabulary for every application control. Surfaces import from `ui/`,
never from a component library. Implementation behind each primitive is chosen
per-primitive (see ADR-0014).

## Component inventory

### Components we write

| Component       | Module             | Props                                                                                                                  | Today's consumers                                                                                                                                                                           |
| --------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Button**      | `button.tsx`       | `children`, `onClick`, `disabled`, `title`, `ariaLabel`, `type`, `variant`                                             | `connections.tsx` (header buttons, form actions), `settings.ts` (`st-retry-btn`, `st-secret-replace/clear`, `st-reset-btn`), `export-section.tsx`                                           |
| **TextField**   | `text-field.tsx`   | `value`, `onInput`, `type`, `label`, `disabled`, `error`, `description`, `id`, `placeholder`, `min`, `max`, `required` | `connections.tsx` (inputField/textField/numberField), `settings.ts` (input[type=text/number])                                                                                               |
| **SearchField** | `search-field.tsx` | `value`, `onInput`, `placeholder`, `ariaLabel`, `disabled`                                                             | `settings.ts` (`.st-search-input`), `settings-content.ts`                                                                                                                                   |
| **Checkbox**    | `checkbox.tsx`     | `checked`, `onChange`, `label`, `ariaLabel`, `disabled`                                                                | `connections.tsx` (checkboxField helper), `settings.ts` (toggle controls, filter checkbox), `export-section.tsx`                                                                            |
| **Select**      | `select.tsx`       | `value`, `onChange`, `options`, `placeholder`, `placeholderValue`, `disabled`                                          | `connections.tsx` (credential selector, jump host), `settings.ts`                                                                                                                           |
| **Toolbar**     | `toolbar.tsx`      | `children`, `ariaLabel`                                                                                                | `connections.tsx` (header toolbar), `settings-content.ts` (`.st-rail` nav)                                                                                                                  |
| **Section**     | `section.tsx`      | `title`, `children`, `id`, `class`                                                                                     | `connections.tsx` (`.cm-form-section`), `settings.ts` (`.st-section`), `export-section.tsx`                                                                                                 |
| **Field**       | `field.tsx`        | `for`, `label`, `children`, `description`, `error`, `required`                                                         | New — intended to replace ad-hoc `.cm-field` and `.st-control-col` markup in `settings.tsx`, `connections.tsx`, `export-section.tsx`                                                        |
| **Badge**       | `badge.tsx`        | `children`, `variant` (default, warning, danger, info)                                                                 | New — intended to replace `.st-provenance`, `.st-customized`, `.st-default`, `.st-section-nav-badge`                                                                                        |
| **EmptyState**  | `empty-state.tsx`  | `title`, `description`, `action`                                                                                       | New — replaces `.cm-list-empty` ("No connections yet") and inline "Select a connection to edit" in `connections.tsx`                                                                        |
| **Toggle**      | —                  | —                                                                                                                      | **Not a separate component.** Checkbox already handles the checked/onChange/label contract. Toggle is a visual variant, not a behavioural one. Future CSS-only styling is documented below. |

### Platform primitives (no wrapper needed per ADR-0014)

| Primitive             | Implementation                 | Why                                                                                                                   |
| --------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Dialog                | `dialog.tsx` + `overlay/` core | Native `<dialog>` + `showModal()` — top-layer rendering, Escape/cancel, native focus. ADR-0014. Built in nocx-vxqj.5. |
| Tooltip               | Native `title` attribute       | ~8 call sites, none need rich content.                                                                                |
| Popover/Menu/Combobox | **Not built**                  | Zero consumers. Revisit when a real consumer exists.                                                                  |

### Page primitives (separate ownership — not merged with kit Section)

| Component    | Module              | Notes                                                          |
| ------------ | ------------------- | -------------------------------------------------------------- |
| Page         | `page.tsx`          | Page layout container                                          |
| PageHeader   | `page-header.tsx`   | Page header                                                    |
| PageBody     | `page-body.tsx`     | Page body                                                      |
| PageRail     | `page-rail.tsx`     | Side navigation rail                                           |
| PageScroller | `page-scroller.tsx` | Scroll owner                                                   |
| PageSection  | `page-section.tsx`  | Semantic `<section>` within a Page, with `id` for deep linking |
| SidebarView  | `sidebar-view.tsx`  | Sidebar view wrapper                                           |

### `Section` vs `PageSection` overlap

`Section` (kit) and `PageSection` (page layout) both render an `h2` + children.
They differ in:

- **`Section`** — `<section>` element, `id` for anchor targeting, `class` passthrough. Part of the kit.
- **`PageSection`** — `<section>` element, `id` for deep-linking, gets page-specific spacing from `surface.css`.

**Recommendation: do not merge them.** `Section` is a generic kit component for form
groups and control sections within any surface. `PageSection` is a layout primitive
that participates in the Page's scroll‑anchor and spacing system. A setting row
inside a settings page uses `Section`; the settings page's top-level groups use
`PageSection`. If they converged, the kit would need to import page-layout CSS,
which is the wrong dependency direction.

## CSS

Component styles live in `frontend/src/styles/kit.css`, imported from `style.css:5`.
Rules moved from `style.css` into `kit.css` (duplicated; removal is deferred to
the CSS consolidation sweep — `nocx-xrrl.2`):

| Rule(s) in style.css                                                                                                                                                                                                                                  | Moved to kit.css as                                                    | Component   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------- |
| `.cm-field`, `.cm-field label`, `.cm-field input[type=text/number/password]`, `.cm-field input:focus`, `.cm-field input[type=checkbox]`                                                                                                               | `.ui-field`, `.ui-field label`                                         | Field       |
| `.st-section`, `.st-section-heading`, `.cm-form-section`, `.cm-form-section h2`                                                                                                                                                                       | `.ui-section`, `.ui-section h2`                                        | Section     |
| `.st-empty`                                                                                                                                                                                                                                           | `.ui-empty-state`, `.ui-empty-state__title`, `.ui-empty-state__desc`   | EmptyState  |
| `.cm-list-empty`                                                                                                                                                                                                                                      | `.ui-empty-state` (shared)                                             | EmptyState  |
| `.st-provenance`, `.st-customized`, `.st-default`                                                                                                                                                                                                     | `.ui-badge-warning`, `.ui-badge-danger`, `.ui-badge-info`              | Badge       |
| `.st-error`                                                                                                                                                                                                                                           | `.ui-field-error`                                                      | Field       |
| `.st-search-input`, `.st-search-input:focus`, `.st-search-input::placeholder`                                                                                                                                                                         | `input[type=search]` rule group                                        | SearchField |
| `.st-control-col select`, `.st-control-col select:focus`                                                                                                                                                                                              | `select.ui-kit` rule group                                             | Select      |
| `.cm-header button`, `.cm-header button:hover`, `.cm-header button.cm-primary`, `.cm-header button.cm-close`, `.cm-form-actions button`, `.cm-form-actions button.cm-save`, `.cm-form-actions button.cm-danger`, `.st-secret button`, `.st-retry-btn` | Button variants (`.ui-btn-primary`, `.ui-btn-danger`, `.ui-btn-close`) | Button      |
| `button:focus-visible`, `input:focus-visible`, `select:focus-visible`                                                                                                                                                                                 | Focus-visible ring                                                     | All         |

## Toggle decision

**Checkbox covers it.** A Toggle (iOS-style switch) is a visual variant of a
boolean input — same behavioural contract: checked/unchecked, onChange, disabled,
label. Creating a separate `<Toggle>` component would duplicate every prop and
test. If a switch visual is needed later, it is a CSS-only change on `<input
type="checkbox">` via the `appearance: none` + `::before` pattern, gated on a
class like `ui-toggle`. No component API changes.

## Keyboard and accessibility

Every component:

- Is natively focusable (no `tabindex` needed) or uses explicit `role`.
- Works with keyboard: Enter/Space for buttons and checkboxes, arrow keys for
  Select (native), Tab for navigation.
- Uses `aria-label` when visible text is absent.
- `disabled` prevents interaction and reduces opacity.
- Error states use `aria-invalid` and `role="alert"` on the error message.

## Identity is what a component renders, not what it is spelled

A class is a **kit identity** when a component in this directory renders it, and that
set is computed from the AST — static `class` / `className` / `classList` values on JSX
elements in `ui/**`, and nothing else (`lint-fixtures/scan-kit-identities.mjs`). Comments,
doc strings, `querySelector` arguments and variant lookup tables are invisible to it.

**The `ui-` prefix is not the test, and treating it as one was a bug.** The derivation
used to be a regex over raw source, which swept in prose and lookup tables — eight false
positives from the variant tables alone. It also could not see identities that do not
start with `ui-`, such as the dialog's `nocx-dialog__panel`. Meanwhile the prefix is
genuinely in use by surface classes no component renders — `ui-settings-row`,
`ui-settings-filter`, `ui-export-desc` — and a prefix-based rule would forbid the
settings surface from styling its own markup.

So: `nocx/no-inline-markup` flags a **rendered** class appearing in a file other than the
component that renders it, because that means markup is duplicating a component. Renaming
is never the fix. If a component renders the class, the fix is to use the component.

Two identities per component is normal and deliberate. `ui-checkbox` is the row and
`ui-checkbox__control` is the box; they have different duties and neither may be inferred
from the other. The one that matters most is the identity on the **element that carries
the appearance** — an input, a select, a button. Every defect the kit migration
(`nocx-pp3y`) unwound came from that element having no name, so its rules could only be
reached through an ancestor and each surface wrote its own instead.
