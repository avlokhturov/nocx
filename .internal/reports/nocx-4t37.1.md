# nocx-4t37.1 — one palette (Raycast model), drill-in for target-needing commands

Worker A report. Section B is a parallel worker; this report names every
`main.tsx` line I touched so the two edits cannot collide silently.

## What I built

The palette is no longer a host picker with a few actions bolted on, and it is
not prefix-scoped. The model is Raycast (per the owner's mid-run replacement of
section A): **one field, mixed results, every row carrying its TYPE on the
right** (`Command` / `Host` / `Setting` vocabulary; `Command` and `Host` are
emitted today) **and its context as a subtitle**. Nobody remembers a prefix.

Two entry points, two presentations of ONE dialog component:

- **The tab-strip caret (`qc.show()`, unchanged call site) opens the plain
  server list** — saved profiles, live aliases (with the existing alias
  badge), the ad-hoc "Connect to <typed host>" fallback, and the degraded
  `ssh -G` condition row. No commands, no type badges, no mode switching.
  One job; the speed comes from that.
- **Ctrl/Cmd+Shift+P (`qc.showPalette()`) opens the palette** — commands and
  hosts mixed, each row typed on the right, ad-hoc and degraded host rows
  still working inside it.

The whole point: **a command that needs a target drills in inside the same
surface** (`DrillCommand` in `quick-connect.tsx`). A command declares
`steps` (`{ name, fetch(selections) }`) and the surface gives it a picker for
free: activating it replaces the list with step 0's choices, the chosen steps
accumulate as breadcrumbs above the filter (`Forward a port › myserver › port`),
and **Backspace (on an empty filter) or Escape walks back one step at a time**;
Escape at the drill root returns to the palette, and only then closes.

Demonstrated with **"Forward a port"**: server (saved profiles — a forward is
profile-owned; `tunnel.open` resolves the profile and dials its own
connection, so aliases, which have no profile, cannot be targets) → port (the
server's listeners via `ports.sample`) → runs the same `tunnel.open` the
ports panel drives, with the EADDRINUSE → allocate-port-0 retry, scope
`palette:<profileId>`. The port step renders the discovery STATE as a typed
row when sampling cannot answer (`Ports: pending` / `no-ssh-…`), and
`No listening ports` when the server genuinely has none — **a degraded source
and an empty source are different facts**.

Shell commands are not palette entries: the semantic command line already owns
cwd/host/grammar/history/existence, so "two command lines where one is stupider
is a worse product" — the palette only carries product verbs.

## What I threw away (the pre-replacement section A)

The owner replaced the model mid-run; the earlier prefix-scoped work was
reworked, not kept:

- The `>` command-prefix mode entirely: `COMMAND_PREFIX`, `isCommandMode`,
  the command/host provider partition (`commands` flag on
  `QuickConnectProvider`), the prefix-aware `filteredItems`, the
  "No matching commands" empty state, the dynamic prefix placeholder/aria.
- Seeding the chord with `>` (`qc.show('>')` → `qc.showPalette()`), the
  `initialQuery` prop, and the controller's seeded-query plumbing.
- The e2e assertions about a seeded prefix ("clearing the prefix returns to
  hosts") — replaced by the caret-vs-palette split and the mixed typed rows.
- The `commands` flag test and the old palette-mode jsdom suite.

The mixed-list model kept everything the host side had earned: ad-hoc
`user@host`, saved-profile-over-alias ranking, degraded `ssh -G` surfacing.

## Design notes / judgement calls

- **Drill server step is saved profiles only** (not aliases): a forward is
  profile-owned (`tunnel.open` resolves the profile's config, credentials and
  jump route; AD-4), so an alias — which has no profile id — cannot be a
  forward target. Aliases in the palette still connect as always.
- **"Forward a port" is appended LAST among commands**: the first row is what
  Enter activates on open, and that stays the muscle-memory "Local shell".
  The drill is one typed word away ("forward").
- **Escape while drilling**: the overlay stack owns Escape at
  document-capture and would close the dialog before a bubble-phase handler
  could walk back. `Dialog` gained an opt-in `onEscape?: () => boolean` veto
  consulted in both the stack's close callback and the native cancel path;
  the palette returns true while a drill is in progress. Zero change to the
  stack's semantics; `dialog.tsx` is the only kit file touched (+15 lines).
- `QuickConnectItem` gained a **required `kind`** (`command | host |
  setting`) — the type badge is the point of a mixed list, and the compiler
  enforces every row declares one.
- Drill step choices are cached per depth, so Backspace restores a step
  without re-fetching (the port step would otherwise re-sample the server).

## Verification

- `./node_modules/.bin/tsc --noEmit` — clean.
- `npx eslint src/ --max-warnings 0` and `npm run lint` (incl. CSS fixture
  checks) — clean.
- `npx prettier --check src/` (and the e2e spec) — clean.
- `npm test -- --run` — **108 files, 1880 tests pass** (new: palette mixed
  rows + badges, caret host-only, ad-hoc-in-palette, drill server→port→run,
  Backspace/Esc walk-back, degraded-in-both-presentations; updated: command
  kinds, drill-command order).
- **e2e `quick-connect.spec.ts` — 6/6 pass** against the real headless
  backend (`cmd/devharness` + vite, disposable HOME, Nix playwright
  chromium): caret opens the plain server list (no commands), chord opens the
  palette with typed rows, typing filters to "Forward a port", Enter on
  "Local shell" opens a tab, Escape closes and restores focus. The drill
  itself is jsdom-covered (no server with listeners exists on a fresh stand).
- No Go touched; `go build ./...` not run (nothing to prove).

## `main.tsx` — lines I touched (for worker B)

- Imports: lines 33 (`type DrillCommand`), 37–39 (`profileRows`,
  `showToast`, `TunnelOpenResult`).
- `openForward` runner + `forwardPortCommand` (the drill): lines 342–450.
- `ActionsQuickConnectProvider` construction: the 4th argument
  `forwardPortCommand` at line 461 (inside the providers block 458–469).
- Chord handler: line 490 (`qc.showPalette()`), comment 486–492.
- `strip.onQuickConnect` (line 477) is UNCHANGED — the caret keeps `qc.show()`.

## Left for later / notes

- `Setting` is part of the type vocabulary but nothing emits it yet — adding
  settings rows later is a provider, not a surface change.
- Root `node_modules` was installed once (113 packages) to run Playwright for
  the e2e verification; it is gitignored. The disposable e2e home and
  `/tmp/devharness-e2e` were removed; the devharness and vite processes were
  stopped.
- The drill demonstrates the capability with one command; the next
  target-needing command declares its steps and gets the same picker — the
  second command must not hand-roll its own second step.
