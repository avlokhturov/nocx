# nocx-wzc4.10 — the local machine reaches the user

Status: complete (frontend, Worker B for nocx-wzc4.8). Consumes the `"local"`
wire identity per section 1 of `.internal/reports/nocx-wzc4.8.md`. No commit,
no push, no bd; frontend/src only.

## What was built

The panel's scope is now the **ports target id**, not the saved-profile id:

- `frontend/src/ports-client.ts` — new `LOCAL_TARGET_ID = 'local'` export (the
  frontend's name for `discovery.LocalTargetID`), kept in the light ports.*
  seam so the panel and the tab identity share one literal without dragging
  the terminal module graph into the panel.
- `frontend/src/terminal-content.ts` — the `profileId` getter is replaced by
  `portsTargetId`: `'local'` for a local shell (`sshOpts === undefined`), the
  saved-profile id for a saved-profile SSH tab, `null` for an alias tab (no
  profile until adopted). This is the one place the three-way distinction
  exists; `profileId` could not tell a local shell from an alias.
- `frontend/src/tabs.ts` — `TabManager.activeProfileId()` → `portsTargetId()`
  with the same three-way answer for the active tab.
- `frontend/src/main.tsx` — the sidebar feed signal, the shared Pause
  control, and the header button's disabled state all read `portsTargetId()`.
  The header Pause is now enabled on a local tab, and `ports.pause` /
  `ports.visible` / `ports.status` / `ports.sample` are keyed by `'local'`,
  exactly like a profile id.
- `frontend/src/ports.tsx` — the panel renders the local machine:
  - **Local row: copy-address, no Forward.** The detected-row action is
    `isLocal ? copy (data-testid="ports-copy") : forward`. `forward()` also
    guards `pid === LOCAL_TARGET_ID`, so a stray call can never dial
    `tunnel.open` with the local target (the invariant is structural, not
    just UI).
  - **Local pending never says "no connection".** The `!host && pending`
    branch renders "Waiting for the first sample" for a local scope and keeps
    "No active connection" (with the SSH-inviting copy) for a profile with no
    session yet.
  - **Forwarded / Stopped sections hidden on a local scope.** The whole
    forwarding vocabulary is an offer of an impossible action on the machine
    you are on — an empty "Forwarded" section whose empty state says
    "Forward a detected port…" would contradict the wire contract's "must NOT
    offer forwarding". Backend still guarantees `forwards: []` for local, and
    the sections are empty-guarded anyway; the wrap is the explicit contract.
  - **Permission-denied evidence is untouched code** — the same
    `processLabel` warning badge renders on a local row as on a remote one,
    because it is a fact about privilege, not an error on the user's own
    machine. A test pins that.

## What was found

The layout-fix trap named in the brief was already handled by the previous
worker (`renderPanel` builds the pause control once, outside the JSX — see
the comment in `ports.test.tsx`); the `solid/prefer-show` lint gate caught my
two ternaries and they became `<Show>`/`fallback` — the kit's dialect.

One real trap hit mid-run: putting `LOCAL_TARGET_ID` in `terminal-content.ts`
made `ports.tsx` import the terminal module graph, which changed the hoisted
`vi.mock('./renderers/xterm')` evaluation order in `ports-view.test.tsx`
(the mock factory references `createRendererMock`, which lives in a module
evaluated *after* the new import edge, so the factory ran before its import
initialized: `Cannot access '__vi_import_7__' before initialization`). Moving
the constant to the light `ports-client.ts` seam removed the edge and fixed
it without touching the mock.

## Acceptance mapping

- A local tab shows this machine's listeners — view test: the initial local
  tab drives `ports.status('local')` and renders the listener row.
- A local row offers copy-address and NO Forward — component and view tests:
  `ports-forward` absent, `ports-copy` present; clicking copy writes
  `host:port` and `openForward` is never called.
- Neither local nor SSH profile (alias, Settings) → no-connection state —
  view test: an alias tab (`newSSHTab('', …)`) shows "No active connection"
  and makes no `ports.*` call; component test keeps the null-scope case.
- Local ↔ SSH re-scope both ways — view test: `'local'` → `'ssh:p1:1'` →
  `'local'` on `activateByIndex(0)`.
- Permission-denied on local renders identically to remote — component test
  asserts the same "owners hidden — run as root to see owners" caution.

## Tests

New (8): 4 component-level in `ports.test.tsx` (local scope + listeners, row
copy + no `tunnel.open`, permission-denied parity, pending-not-no-connection)
and 3 view-level in `ports-view.test.tsx` (local listeners through the real
sidebar, local↔SSH↔local re-scope, alias no-connection), plus the
null-scope component test retitled. `mountApp` now feeds
`manager.portsTargetId()`.

## Gates

- `tsc --noEmit` — clean.
- `eslint . --max-warnings 0` (the repo's `npm run lint`, incl. css fixture
  checks) — clean.
- `prettier --check src/` — clean.
- `npm test -- --run` — 108 files, 1877 tests, all green (was 1855; +22 net
  after the two retitled/reworked tests).
- `contracts:check` — clean (no contract touched; the generated ports types
  already carried the "local" JSDoc from nocx-wzc4.8).

## Files

- `frontend/src/ports-client.ts` (+7) — `LOCAL_TARGET_ID`.
- `frontend/src/terminal-content.ts` — `profileId` → `portsTargetId` getter.
- `frontend/src/tabs.ts` — `activeProfileId()` → `portsTargetId()`.
- `frontend/src/main.tsx` — sidebar/Pause feed from `portsTargetId()`.
- `frontend/src/sidebar.tsx` — `SidebarViewProps.activeProfileId` doc now
  names the reserved `"local"` value.
- `frontend/src/ports.tsx` — local rows (copy, no Forward), local pending,
  forwarding sections hidden on local scope, `forward()` local guard.
- `frontend/src/ports.test.tsx`, `frontend/src/ports-view.test.tsx` — new
  local-machine coverage through both the component seam and the real
  sidebar + TabManager.

Left for later beads: `-R` exposure from local (explicitly out of scope in
the wire contract), relay provider, darwin libproc swap — all unchanged from
nocx-wzc4.8's section 4/5.
