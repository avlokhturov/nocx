# nocx-wzc4.2 — ports panel: report

## What shipped

**Backend — discovery is now a feature (AGENTS.md rule 2):**

- `internal/discovery/schedule.go` (new): `Scheduler`, the cadence owner. Per-profile
  targets with four named timers: **settle sample** after connection up (1 s),
  **prompt debounce** (1 s, coalesced), **periodic sampling** (10 s) gated on panel
  visible AND not paused, and **one sample in flight** (per-target trigger channel
  coalesces nudges onto a single sampler loop; the Detector's semaphore is the
  second guard). Connection loss is watched via the lease's `Done` channel —
  no execs on a dead lease, and `ConnectionUp` after a loss builds a FRESH
  detector (probe selection is once per connection; stale results never survive
  reconnect). `ConnectionDown` (last tab closed) releases the lease and forgets
  the target — no poll outlives its consumer, no pooled connection is held idle.
  Lease acquisition is singleflighted and bounded by a 15 s timeout.
- `internal/transport/ws_ports.go` (new): `ports.status` / `ports.sample` /
  `ports.pause` / `ports.visible` — the read path. `ports.status` assembles the
  discovery state + the backend's tracked forward ledger (including
  connection-loss stops). `ports.sample` is synchronous Retry: clears a terminal
  refusal and returns the FRESH state, not the pre-retry one.
- `internal/app/app.go`: composition root wires `discovery.NewScheduler(sshClient, …)`
  with the cadence named explicitly (spec §4); closed in `Shutdown`.
- Cadence hooks (transport): settle sample on remote session open (only after the
  session is fully established — a failed ring setup leaves no orphan target);
  prompt hint rides the existing `history.record` seam (one line in
  ws_history_record.go, resolved backend-authoritatively from the tab's own
  sessions — the other worker's `shell.integrate` needs to do nothing for
  discovery); target teardown in `monitorExit` + `closeSession`.
- `contracts/ports.{status,sample,pause,visible}.schema.json` + generated renderer
  types. `additionalProperties: false` + explicit `required` everywhere; listeners
  and forwards pinned as never-null arrays (the `[]` vs `null` trap).

**Frontend — `frontend/src/ports.tsx` + `ports-client.ts`:**

- `PortsPanel`: **Detected** (address:port, three-valued process evidence,
  Forward one action per row), **Forwarded** (local addr → destination, Copy,
  Open, Stop), **Stopped** (only when non-empty; reason + error + Retry for
  error/connection-lost only). A busy local port falls back to an allocated
  loopback port (EADDRINUSE catch → retry with port 0).
- States render as facts: `available`+empty = "Nothing is listening" (the ONLY
  case); `unavailable`/`failed-transiently`/`permission-or-policy-refused`/
  `connLost`/`pending` each render a distinct sentence; `permission-denied`
  process evidence renders "owners hidden — run as root to see owners";
  probe-less hosts say so with classification + probes tried. Pause/Retry in the
  header; last-sample time shown.
- `PortsContent.setVisible` reports visibility → `ports.visible` (hidden tab
  pauses sampling) and gates the 5 s status poll.
- Kit used: Page (titleHidden), PageBody, Section, Button (default), Badge,
  EmptyState, Stack, showToast. No new kit components added.

## Evidence

- `deadcode -filter 'nocx/internal/discovery' ./...` → **empty (0 bytes)** —
  the option constructors are production-reachable: the composition root names
  the cadence, the scheduler names the detector's timeout/backoff it builds with.
- Tests: discovery 31 → 40 (+9 scheduler tests, all `-race` green: settle,
  debounce coalescing, in-flight coalescing, hidden-tab pause, pause, retry,
  connection-loss/reconnect, lease release, pending status). Transport: +4 DTO
  conformance + 1 over-the-wire (real socket, real handler, real scheduler over a
  scripted connector; asserts `[]` never `null`, permission-denied evidence,
  pause/visible flags echoed, unknown-profile pending, -32602 on missing
  profileId). Frontend: +11 panel tests (reachability, forward reaches client +
  moves to Forwarded, busy-port fallback, hidden-tab visibility, permission-denied
  explanation, probe-less host ≠ "nothing is listening", stopped reasons/retry).
- Gates: `go build ./...`, `go vet`, `golangci-lint run` (scoped packages), full
  `go test -race` on the three touched packages, gofmt clean. Frontend: `tsc
  --noEmit`, full `eslint . --max-warnings 0`, `prettier --check src/`,
  `contracts:check`, full vitest (103 files, 1808 tests) — all green.
- Test counts before/after: transport full suite still green (no before count
  captured — the suite ran clean at 27.5 s; 1808 frontend tests pass).

## Files modified

```
internal/app/app.go                      (wiring + shutdown)
internal/discovery/schedule.go           (new — Scheduler)
internal/discovery/schedule_test.go      (new — 9 tests)
internal/discovery/discovery_test.go     (fakeConn: autoValid test seam)
internal/transport/ws_ports.go           (new — ports.* RPC + hooks)
internal/transport/ws_ports_test.go      (new — DTO + over-the-wire)
internal/transport/ws.go                 (minimal: import, field, dispatch, 3 hooks)
internal/transport/ws_history_record.go  (1 line: prompt hint)
contracts/ports.{status,sample,pause,visible}.schema.json (new)
frontend/src/ports.tsx                   (new — panel + content)
frontend/src/ports-client.ts             (new)
frontend/src/ports.test.tsx              (new — 11 tests)
frontend/src/generated/ports.*.ts        (generated)
frontend/src/styles/surfaces/ports.css   (new — placement only)
frontend/src/style.css                   (1 import)
```

main.tsx, internal/tunnel, internal/ssh/ssh_tunnel.go: **untouched**.

## For the palette worker (main.tsx)

```ts
import { PortsContent, createPortsPanelServices } from './ports'
const services = createPortsPanelServices(dispatcher)   // dispatcher already exists
const content = new PortsContent(profileId, services)   // profileId of the active tab
// then registry.register(...) with surfaceType 'nocx.ports', singletonKey null,
// defaultTitle 'Ports'; open via tm.openTab(content, descriptor)
```
The content's setVisible already reports visibility (hidden tab pauses sampling).

## What I could not verify

- End-to-end in a real browser against the dev stand (no UI harness in this
  scope; the palette trigger is the other worker's slice).
- Real-remote probe behavior — the transport over-the-wire test uses a scripted
  connector; genuine `ss`/netstat/lsof runs are covered by the discovery
  package's own tests (parsers + real exec over the in-process SSH server).
- Block-attached offer (spec §9) — explicitly not in this brief's deliverables.
