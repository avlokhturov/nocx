# nocx-wzc4.8 — the local machine listens too, and we ask the kernel

Status: complete (backend). Worker B consumes the wire identity below.

## 1. THE WIRE SHAPE FOR B (read this first — B is blocked on nothing else)

The reserved target identity for a local tab is the **literal string `"local"`** —
`discovery.LocalTargetID` in Go, documented in both ports.* schemas.

- A local tab calls `ports.status` / `ports.sample` / `ports.pause` /
  `ports.visible` with `profileId: "local"`, exactly like a profile id.
  Profile ids are always `type:custom:slug:uuid`, so the bare value can never
  collide with a stored profile.
- The result is the normal `PortsStatusResult` shape — **no new fields**:
  - `profileId: "local"` (echoed),
  - `host`: the machine's hostname (display material),
  - `discovery`: the same five states, same three-valued `process.evidence`,
    same listener rows — `probe` is `"linux-procfs"` / `"darwin-lsof"` /
    `"windows-getextendedtcptable"` per OS,
  - `forwards: []` — **always empty for local**, and the renderer must NOT
    offer forwarding actions on a local row (nothing to forward from the
    machine you are on; replace with copy-address).
- A local tab with no discovery target yet reports state `"pending"`, exactly
  like a profile before its first connection — never "no connection".
- The local target's lifecycle mirrors a profile's: created when the first
  local tab opens, torn down when the last closes (Pause, visible and prompt
  hints are all keyed by `"local"`).
- Permission-denied evidence arrives on local rows **identically** to remote
  (non-root walks only own processes): render it the same way, not as an error
  on the user's own machine.

Generated types (`frontend/src/generated/ports.{status,sample}.ts`) were
regenerated from the schema; only JSDoc changed, no fields.

## 2. What was built

Two providers behind one domain interface (AD-8):

- `internal/discovery` owns the domain — `Listener`, the five states,
  three-valued evidence, the cadence — and knows nothing about how listeners
  are obtained. New: the `Provider` interface (`Sample/Retry/Close`), the
  `WithLocalProvider` composition-root option, `LocalTargetID`, and the
  exported `SampleState` projection both transports share.
- **remote** — the existing ladder over an exec channel, behaviour unchanged.
  The exec seam from the first brief version is kept and is what makes
  discovery transport-neutral: `ExecConn`/`ExecError` in discovery,
  `adaptSSH` bridging `ssh.DiscoveryConn`, so the ladder names no transport
  and the discovery tests need no SSH server (a scripted seam fake).
- **local** — `internal/nativeports`, its own package, one build-tagged
  implementation per OS (the `internal/contentkey` pattern):
  - `_linux.go`: `/proc/net/tcp{,6}` (state `0A` = LISTEN, inode column),
    owner via socket-inode readlink over `/proc/*/fd`; permission-denied
    evidence falls out of the walk (EACCES on others' fd dirs). Read caps: 8
    MiB per table, 1 MiB shared fd-walk budget, 64 B per comm read.
  - `_windows.go`: `GetExtendedTcpTable` from `iphlpapi.dll` bound through
    `golang.org/x/sys/windows`' DLL machinery (x/sys v0.47.0 does not wrap
    the TCP-table syscalls, so the MIB structs + proc are declared locally).
    Pure Go, no cgo, no PowerShell.
  - `_darwin.go`: **`/usr/sbin/lsof` — a documented fallback, not a kernel
    read** (decision below).
  - `_other.go`: `ErrUnsupported` → discovery `unavailable` state.

Wiring: `internal/app` passes `nativeports.NewProvider` into the scheduler;
`internal/transport` hooks fire for local sessions (`discoveryUpLocal` on
open, prompt hints, last-local-tab teardown) — all keyed by `"local"`.

## 3. The macOS decision — lsof now, libproc next, with evidence

**Chosen: `lsof` fallback in `_darwin.go`, with libproc/cgo named as the
native upgrade and its cost already measured as nil.** Evidence gathered:

1. `go test -race` is the CI gate on **`macos-latest`** runners
   (`.github/workflows/ci.yml:85`, backend job); Go's race detector on darwin
   still requires cgo — the backend CI already compiles cgo on macOS today.
2. The release build is `wails build -platform darwin/universal`
   (`release.yml:124`); Wails v2's darwin shell is cgo by construction. The
   shipped app cannot build without cgo.
3. `CGO_ENABLED` is set nowhere (Makefile, wails.json, CI), so it defaults to
   1 wherever Xcode CLT is present — and Wails requires that toolchain anyway.

So the brief's condition ("if `-race` and the release build already pull it
in, the cost is nil") holds: **introducing `import "C"` for libproc adds zero
new toolchain requirement to any existing build path.** Why, then, lsof now:
this worker runs on Linux and cannot compile, vet, or run darwin cgo; a blind
libproc implementation's failure modes are silent (wrong struct offsets or
constants compile clean and return garbage), and shipping that on the
macOS-first product is the higher-risk choice. lsof ships with every macOS
base system (`/usr/sbin/lsof`), its `-nP -iTCP -sTCP:LISTEN` dialect is
stable, and the fallback lives in the native module behind the same
interface. The swap to libproc later is a one-function, one-file change.
**Named follow-up: runtime-smoke `_darwin.go` on a macOS box (and
`_windows.go` on a Windows box — same blind-write constraint) before release;
the state-mapping logic is fully tested on Linux.**

## 4. The relay seam (nocx-if6 phase B)

`internal/nativeports` reads the kernel of whatever machine it runs on and
cross-compiles for every target (`GOOS=linux|darwin|windows|freebsd go build`
all green) — the relay can ship it to the far host unchanged. The
`discovery.Provider` interface is the third-implementation seam: a relay
provider implements `Sample` by querying the far side, dropped in beside
local and remote-command without forking either. **The one part that would
change**: the scheduler's target→provider mapping — today a
`LocalTargetID`-special-case plus the SSH `Connector`; a relay lands as
another factory wired at the composition root, generalizing that mapping
into a small target-kind table. Nothing in `nativeports` itself would change.

## 5. Deliberate decisions (reference diff: Orca's relay port scan)

- **Self/ppid exclusion: REJECTED.** Orca's scan runs on the relay host and
  filters its own listener because that scan rides the very connection it
  filters. The local panel is not riding a connection, the shipped nocx app
  binds no TCP port (Wails IPC), and the acceptance test requires a port the
  test itself opened to be visible — self-visibility is a hard requirement.
- **sshd/port 22 exclusion: REJECTED** for the same reason — locally a real
  service, not the connection in use. (The remote panel's ladder is
  unchanged, so the remote-side noise the owner saw is untouched.)
- **Sort before cap: TAKEN.** `Listeners` sorts by port (address tie-break)
  so the visible set never depends on `/proc` enumeration order; the 2048-row
  memory guard applies after the sort. The reference's **50-row cap is
  rejected** — nocx's remote panel is uncapped and local must match it (the
  sidebar scrolls; the wire is not size-limited).
- **host:port dedupe: REJECTED** — every kernel row is a listener (SO_REUSEPORT
  is two rows), matching the remote ladder's row-for-row semantics.
- **Copy-address replaces forwarding** on local rows (your candidate): the
  address is the row's primary key; copying is useful, needs no permission
  surface, and `-R` is explicitly a later bead.

## 6. Test-first evidence

- `nativeports.TestProvider_ListsPortOpenedByThisTest` — opens a listener in
  the test, drives the real `Provider.Sample`, asserts the port AND that the
  test's own pid carries `known` evidence. Cannot pass against a stale table.
- `nativeports` failure branches (AGENTS rule 3) with an injected read:
  `ErrUnsupported` → `unavailable`, `ErrToolMissing` → `unavailable`, generic
  read error → `failed-transiently` with the cause named; success projects
  through the same `SampleState` as remote (mixed → available, all-denied →
  available-limited, empty → available).
- `discovery` scheduler: local target settle-samples via the wired provider,
  never touches the SSH connector; local+SSH targets re-scope independently
  in **both** directions (closing either leaves the other sampling).
- `transport.TestPorts_LocalTarget_OverTheWire` — the real handlers through
  the real socket with the real `nativeports` provider: pending → settle →
  `"local"` status with real listeners, `forwards: []`, hostname; open/close
  of a local session drives the lifecycle; SSH target on top re-scopes.
- The discovery domain tests (ladder, states, refusal/backoff) run against
  the scripted seam fake — no SSH server needed (the real-SSH e2e remains as
  the adapter's integration check).

## 7. Gates

- `go build ./...`, `go vet ./...`, `gofumpt -l`, `golangci-lint run`: clean.
- `go test -race` on touched packages: `internal/discovery`,
  `internal/nativeports`, `internal/transport` — all green.
- `go test -race ./...` repository-wide: fails in untouched
  `internal/shellintegration` — zsh missing from PATH and bash OSC-636
  marker tests. **Pre-existing**: same failures reproduced with my changes
  stashed (base tree). This NixOS box has no zsh/dash; CI runs the suite on
  macOS where zsh ships. Not caused by this work.
- Frontend: `contracts:check`, `tsc --noEmit`, `prettier --check`,
  `eslint --max-warnings 0`, `npm test -- --run` (106 files, 1855 tests): all
  green. Only the two generated ports artifacts changed.

## 8. Files

- New: `internal/discovery/exec.go`, `internal/discovery/provider.go`,
  `internal/discovery/ssh_adapter.go`, `internal/nativeports/` (provider +
  four OS listeners + tests).
- Modified: `internal/discovery/{discovery,schedule}.go` (+ tests),
  `internal/app/app.go`, `internal/transport/{ws,ws_ports}.go` (+ test),
  `contracts/ports.{status,sample}.schema.json`, generated
  `frontend/src/generated/ports.{status,sample}.ts`.
- Deleted: the first-version local shell-out (`local.go`, `local_test.go`) —
  superseded by the native module per the corrected brief.

Left for B: consume `"local"` per section 1. Left for later beads: `-R`
exposure, relay provider (section 4), libproc swap on darwin (section 3).
