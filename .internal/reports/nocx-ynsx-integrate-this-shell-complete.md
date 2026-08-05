# nocx-ynsx — Integrate this shell: completion report

**Status: DONE** (all items 1–5 of the resume brief; worker_done sent with `--outcome succeeded`).

## 1. The echo decision, applied

`internal/shellintegration/inband.go`: wrapper now runs `stty raw -echo` inside the
transient delivery window, restored by the exact `stty "$saved"` on every path. The
dispatcher ends with a top-level `return 0 2>/dev/null || exit 0` (the fall-through
fix: `NOCX_IB_BASH_START` can no longer execute as a command after the dispatcher's
cleanup).

**The three payload-leak assertions are green on bash, zsh AND dash** (real ptys;
zsh/dash provisioned via `nix shell nixpkgs#zsh nixpkgs#dash`).

**ECHO-restored assertions, sampled at the moments that actually matter.** Two
measured facts shaped them: (a) at the readline/zle prompt tty ECHO is legitimately
OFF (`Lflag 0x8A31` — readline echoes itself), so "ECHO set after the window" sampled
at the prompt is a false predicate; (b) `stty -g` cannot represent the kernel's fresh
pty Cflag `0xBF` — it renders `0xF00BF` and any `stty "$saved"` roundtrip normalizes
to it (verified by experiment). So:

- **Window silent:** ECHO off, captured at READY arrival (the wrapper emits READY only
  after `stty raw -echo`). Asserted on all three happy paths + cancel.
- **Restore boundary:** ECHO on at the OSC 636 hello (bash) / A marker (dash) — the
  moment the exact restore completed, before any user code or readline re-prep.
  zsh has no source-time anchor (zle owns the terminal when precmd fires, measured
  `0x8A31`), so zsh asserts bit-exact before==after instead, documented.
- **Cancel/fail-open:** `assertEchoUnchanged` + the existing bit-exact `before==after`
  (the prompt's echo behavior is proven identical to pre-window).
- **Fixture:** startSession seeds the pty to the canonical `0xF00BF` encoding so the
  bit-exact comparisons test the wrapper's restore, not the kernel's encoding
  artifact; dash gets an `ENV` rc so it has the test prompt.

## 2. Transport RPC `shell.integrate`

- `internal/transport/ws_shell.go` (new): narrow `InBandBootstrapper` interface
  (satisfied by `*shellintegration.Impl`, no adapter), `WithInBandBootstrapper`,
  `handleShellIntegrate`. Params `{sessionId}`; missing → -32602; session not live in
  the registry → -32602 (AD-7: server-authoritative id); unwired → -32603 fail-closed.
- `internal/transport/ws.go`: exactly one struct field + one dispatch case (the
  minimal footprint the coordinator asked for).
- `internal/app/app.go`: composition-root wiring with the reachability comment.
- `deadcode -filter 'nocx/internal/shellintegration' ./...` prints NOTHING (exit 0) —
  `InBandBootstrap` is reachable from main() now.

## 3. Contract + conformance

- `contracts/shell.integrate.schema.json` (additionalProperties:false + required),
  generated `frontend/src/generated/shell.integrate.ts` via `npm run contracts`,
  `npm run contracts:check` green.
- `internal/transport/ws_contract_test.go`: DTO conformance + `OverTheWire` test that
  drives the REAL `*shellintegration.Impl` through a real socket, plus
  unknown-session (-32602) and unwired (-32603) cases.

## 4. Frontend

- `input-state.ts`: `owned` getter added (was machine-only).
- `renderers/types.ts` + `xterm.ts`: `onInBandReady` — OSC 1337 handler whitelisting
  exactly `NOCX_IB_READY`, returning an unsubscribe so the consumer registers right
  before sending the wrapper and removes the listener on success/cancel/timeout/
  error (no stale READY can trigger a stream).
- `terminal-content.ts`: `integrateShell()` — gate `PROMPT_READY && trusted &&
  owned` with a stated refusal (toast + log); the input lease is taken BEFORE the
  RPC: draft (text+selection+scroll) captured byte-for-byte, editor hidden, every
  key except Esc swallowed at document capture phase, kit FloatingPanel
  ("Integrating this shell — Esc to cancel") in the terminal; wrapper typed only
  once the lease is held; payload streamed only after READY; completion at the next
  OSC 133 A; Esc sends the terminator alone (only when READY was seen — a stray
  terminator at a prompt would be fail-open noise); 15 s timeout; dispose aborts the
  lease.
- `shell-client.ts` (+ test): narrow `ShellRpc` seam, `integrate(sessionId)`.
- `tabs.ts`: `activeTerminalContent()` accessor. `quick-connect.tsx`:
  `__integrate_shell__` palette item (reachable via the existing palette
  keybinding, Ctrl/Cmd+Shift+P). `main.tsx`: wires the item to the active tab's
  `integrateShell()` and adds a DEDICATED keybinding, Ctrl/Cmd+Shift+I, that
  routes to the same gate — intercepted only while the active tab is a terminal;
  it collides with WebKit's devtools shortcut, which has no inspector to open in
  release builds (the tradeoff is named in the code comment).
- Tests: 5 in-band integration tests (refusal RAW / refusal trusted-unowned /
  success with byte-for-byte draft restore + no keystroke interleave / Esc cancel
  via terminator / RPC failure releases the lease); OSC 1337 renderer test
  (whitelist + unsubscribe); quick-connect item updated; shell-client wire test.

## Gates (all green)

- Backend: `go build ./...`, `go vet`, `gofumpt -l` clean, `golangci-lint run`
  (shellintegration/transport/app) clean; `go test` shellintegration + transport
  (real bash/zsh/dash) all pass.
- Frontend: `tsc --noEmit`, `eslint src/`, `prettier --check src/`,
  `npm run contracts:check` clean; 216 tests pass across the touched suites
  (terminal-content, quick-connect, input-state, renderers/xterm, shell-client,
  tabs, tab).

## What I could not verify

- Real-browser behavior of the palette item / indicator panel (no browser run in
  this environment); the ready-wait streaming is covered by the backend pty tests
  and the frontend unit tests instead.
- The zsh/dash paths were verified on the nix-provisioned binaries (5.9.2 / 0.5.13.5).

## Files modified

Backend: `internal/shellintegration/inband.go`, `inband_test.go`, `inband_pty_test.go`
(new), `internal/transport/ws_shell.go` (new), `ws.go`, `ws_contract_test.go`,
`internal/app/app.go`, `contracts/shell.integrate.schema.json` (new).
Frontend: `input-state.ts`, `renderers/types.ts`, `renderers/xterm.ts`,
`renderers/xterm.test.ts`, `terminal-content.ts`, `terminal-content.test.ts`,
`shell-client.ts` + `.test.ts` (new), `tabs.ts`, `quick-connect.tsx`,
`quick-connect.test.tsx`, `main.tsx`, `test-support/tabs-fixtures.ts`,
`generated/shell.integrate.ts` (generated).
