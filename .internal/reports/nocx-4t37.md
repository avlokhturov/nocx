# nocx-4t37.2 — a mode, not a nag (worker B report)

Date: 2026-08-04. Worker B, section B of `nocx-4t37-offers-and-palette.md`
(the section rewritten after the owner's second reading: a MODE, not an
offer). No commits, no pushes, no `bd` writes were made.

## What shipped

A **capability statement** above the pending command on SSH tabs — not a
three-position selector, and the word "nocxify" appears nowhere in the UI
(per the owner's correction). The rail chip states what is true right now:
**Native input / Command blocks / Enhanced input** (labels from the
correction), and its popover offers the two real transitions: _Integrate
this shell_ (from a plain shell) and _Use native input_ (from an integrated
one). `relay` exists in the model (`frontend/src/capability.ts`, the
`ShellMode` axis `terminal | nocxify | relay`, mirroring `tunnel.Direction`'s
third-value pattern) and is never rendered.

The epic's happy path is verified end to end by `e2e/shell-mode.spec.ts`
against a REAL shell on a REAL PTY: the test's own in-process sshd
(`cmd/e2e-sshd`) runs bash; the user lands on a plain SSH shell (profile
`shellIntegration: ask`), SEES "Native input", clicks the chip, takes the
one action, and after the in-band bootstrap the chip reads "Command blocks"
and a typed command becomes a block. Passes (chromium, headless path).

### Backend: the profile setting now has teeth

`profile.ShellIntegrationMode (auto|ask|off, nocx-p0ug)` had zero behavioral
consumers; the launcher was wired unconditionally, so every SSH open
integrated at startup. Now:

- `internal/ssh`: `ConnectConfig.LaunchPolicy` (own enum, same
  ssh-doesn't-depend-on-profile boundary that duplicates `ShellKind` etc.)
  - `launchAllowed()` gate in `shellStartCommand` — ask/off open a plain
    shell (launcher and legacy installer both gated); empty = auto (every
    pre-existing caller unchanged).
- `internal/connection/resolver.go`: effective `shellIntegration` →
  `LaunchPolicy`; `internal/session` carries it through the option
  conversion (a field carried and discarded was the failure mode named in
  the code).
- The `open` ack carries the resolved policy (`shellIntegration`) + the
  existing reason: contract `contracts/open.schema.json` (regenerated
  `frontend/src/generated/open.ts`), DTO + over-the-wire tests extended.
  The policy rides the ack so the tab never re-fetches and can never
  disagree with the backend's own resolution.
- Tests: policy gate (ask/off → launcher not consulted, plain shell, reason
  none; empty → integrates), resolver mapping (4 rows), transport ack
  (default auto when the resolver stamps none).

### Frontend: the rail

- `input-state.ts` untouched (per the coordinator ruling — see the gate
  note below). "Markers ever arrived" lives on `TerminalContent` as
  `_shellIntegrated`, set only by the marker handler (AD-6).
- The rail (`nocx-capability-rail`, pane-level, above the editor, SSH tabs
  only — a local tab's capability is static, and a permanent chip there is
  the decoration the correction forbids) hosts the kit's new
  `capability-chip` (`ui-capability-chip`, data-variant
  native|blocks|enhanced|degraded, CSS, test, README row) and a
  `FloatingPanel` variant `capability` for the actions.
- Tab chrome carries at most the small warning dot (`nocx-tab-warning`) when
  the environment degraded or became uncertain (open-time launcher decline,
  or markers stopped on an integrated session).
- Policy `off` refuses `integrateShell` from every entry point with a
  stated toast.
- The profile editor (Advanced section + group defaults) gains the
  `shellIntegration` select, mirroring `portDiscovery` exactly; tests cover
  the patch route and the group-defaults route.

## The gate: two named authorisations (coordinator decision, not mine)

The epic's happy path requires in-band integration on a **markerless**
shell, and `PROMPT_READY && trusted && owned` can never hold there — the
A→B window needs markers, markers need integration. Circular. I escalated;
the coordinator ruled (with reasoning about the READY handshake): keep the
machine marker-only, split the gate into two named authorisations:

- **Integrated path (unchanged):** `PROMPT_READY && trusted && owned`.
- **Markerless path (new):** `!shellIntegrated && state !== 'ALT_SCREEN'` —
  ALT_SCREEN is the one positive "a full-screen program owns the screen"
  fact (vim/less/htop refused with a stated reason), and anything else that
  is not a shell is caught by the OSC 1337 READY handshake: only the
  one-line wrapper is ever typed blind, and if READY never returns the
  `IN_BAND_TIMEOUT_MS` fires with nothing else sent. The input lease is
  unchanged. Recorded as a scoping note appended to **ADR-0004 §1**
  (same shape as the existing `-echo` note): the machine governs keyboard
  OWNERSHIP, not one-shot user-initiated delivery whose authorisation is the
  click and whose verification is the READY handshake.

I did not add any state/flag/clause to `reduce()` in `input-state.ts`.

## What I had to throw away (the correction)

1. **The three-position selector** — built the capability model first; the
   correction arrived; the axis stays in the model only, the UI shows the
   observed statement. Nothing of the selector shipped.
2. **Tab-chrome placement** — the indicator lives in the pane-level rail
   above the pending command, not the tab strip. Tab chrome kept only the
   warning dot (also per the correction).
3. **"Save this as a connection" for hand-typed ssh** — implemented submit
   detection + the adopt affordance; the coordinator ruled it is
   **nocx-pu4.4 and out of scope**; removed entirely (the ad-hoc SSH tab's
   existing adopt button already covers the quick-connect path).
4. **A sticky `integrated` flag in the input-state machine** — added, then
   reverted per the ruling; the marker latch is a `TerminalContent` field.

## The four no-trace claims (verified)

1. bash: `exec bash --rcfile <(printf %b "...") -i` — process substitution,
   no disk write (`launcher_bash.go`). ✅
2. zsh: transient `mktemp -d` ZDOTDIR, `.zshrc` template erases the dir
   before user code (`launcher_zsh.go:57-58`). ✅
3. in-band: one wrapper line mktemps a file, sources on the completion
   marker and `rm -f`s it in the same line (`inband.go`). ✅
4. legacy SFTP installer: zero production call sites; `WithRemoteInstaller`
   never wired at the composition root (`app.go` wires only
   `WithRemoteLauncher`). ✅

## Verification evidence

- Go: `go test -race -count=1 ./...` **exit 0, 28 packages** (with
  `nix shell nixpkgs#dash nixpkgs#zsh` — dash/zsh are not on this box's
  PATH, and `internal/shellintegration`'s launcher tests refuse to skip
  without them; pre-existing provisioning need, not a regression).
- `gofumpt -l .` clean; `golangci-lint run` clean (exit 0).
- Frontend: `npm run lint` 0, `npx prettier --check src/` clean,
  `tsc --noEmit` 0, `vitest run` 1887/1887.
- Root `npx prettier --check .` fails on **38 pre-existing files** (old
  briefs, older contracts, one decision doc) — none touched by me; every
  file I modified passes.
- E2E: `e2e/shell-mode.spec.ts` passes (chromium, headless devharness +
  vite).

## What's left / known issues (not mine to fix)

- `e2e/quick-connect.spec.ts` "typing filters the list" is red on main:
  the ad-hoc "Connect to <host>" fallback makes the "No matches" empty
  state unreachable for any host-like query. Pre-existing; the palette is
  worker A's surface.
- The tab-level "mode a profile sets is the mode the tab starts in" is
  honored by the open-ack policy (auto → launcher; ask/off → plain) — the
  profile editor select now exposes it.
- Files touched (B's wiring only): backend
  `internal/ssh/{ssh.go,ssh_real.go}`, `internal/connection/resolver.go`,
  `internal/session/session.go`, `internal/transport/ws.go`,
  `contracts/open.schema.json` + generated `open.ts`, `cmd/e2e-sshd/`;
  frontend `terminal-content.ts`, `capability.ts`, `ipc.ts`,
  `tabs.ts`/`tab.tsx`/`tab-strip.tsx`, `connections.tsx`, `profiles.ts`,
  `ui/capability-chip.*`, `ui/floating-panel.ts`, styles; `e2e/shell-mode.spec.ts`;
  docs `ADR-0004` scoping note. `main.tsx` untouched.
