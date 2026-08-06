# nocx-wzc4.3 — profile forwards + portDiscovery

## What shipped

**`internal/profile`** — a profile now carries two new things (spec D3, D5):

1. **`PortDiscoveryMode` (`auto|ask|off`, default `auto`)** threaded through the
   full option cascade, mirroring `shellIntegration` (nocx-p0ug) site for site:
   dense/stored/sparse structs, both conversions each way, `storedOptsToSparse`,
   `sparseToOptions`, `applySparseLayer`, the group-defaults allowlist,
   `hardcodedDefaults`, the resolution provenance map, `ToEffectiveDTO`, the
   patch-path table, and both patch appliers. An unrecognised stored value
   falls back to `auto` at resolution with provenance `default` — exactly the
   shellIntegration rule (silent `off` was rejected for the same reason).

2. **`Forwards []ForwardSpec`** — stored tunnel definitions, topology only,
   never credentials. All three directions are first-class (D4). The stored
   field is `*[]ForwardSpec`: `nil` = never configured, `&[]` = deliberately
   none — `omitempty` drops an empty slice, so the pointer keeps the
   explicit-empty case alive across JSON. Deliberately **not** in the sparse
   cascade: merging forward lists across layers would invent semantics nobody
   decided. `ValidForwards` is the single validation authority (direction
   closed set, destination `host:port` with numeric port in range, bind port
   0–65535) — the editor and the replay ask the same question.

**`internal/connectfwd`** (new package) — the connect-time replay engine.
`Replay(ctx, profileID, forwards, host, conn, opts) []Result`: each stored
forward is opened on its OWN pooled-connection lease via the injected
`tunnel.Connector` (spec §7.3), in stored order, and every row gets a
`Result` — the tunnel record when one exists plus the row's own `Err`.
Busy local port → that row's bind failure, session untouched; one failure
never stops the others; remote/dynamic rows report the tunnel layer's
not-implemented outcome preserved as their own — never coerced to local,
never dropped (D4). Transport-neutral: it registers nothing; the transport's
ledger stays the only place tunnels are tracked.

## The connect-time seam (NOT wired — explicit handoff)

`connectfwd.Replay` is **tested but unreachable** — `deadcode` reports:
`internal/connectfwd/connectfwd.go:51:6: unreachable func: Replay`.

The wire-up belongs to the transport owner (internal/transport is out of my
scope this wave, per the brief). The seam is small and precise — in
`handleOpen` (`internal/transport/ws.go`), beside the existing
`discoveryUp` call (line ~1095), after the session is established:

```go
// after s.discoveryUp(cfg.ProfileID, cfg.Host, cfg.Remote):
if cfg.ProfileID != "" && s.tunnelConnector != nil {
    prof, err := s.profiles.Load... // load the stored profile (or take forwards from the resolver's effective profile)
    results := connectfwd.Replay(ctx, cfg.ProfileID, prof.Options.Forwards, host, s.tunnelConnector,
        []ssh.ConnectOption{func(dst *ssh.ConnectConfig) { *dst = *cfg }})
    // track running tunnels in the ledger (trackTunnel-equivalent, scoped to the connection),
    // surface Result.Err per row — the panel's Stopped/errors section renders them.
}
```

The `opts` shape (one option copying the whole resolved `ConnectConfig`) is
exactly what `handleTunnelOpen` already passes to its connector (AD-4 pool
keying). Do not block the session on Replay — it never fails the open, but
run it before the ack if you want the ledger populated for `ports.status`.

## Frontend

- **`ui/row-list.tsx`** — new kit primitive `EditableRowList`
  (`ui-row-list` + `__row/__content/__remove/__empty/__add`): repeating
  editable row list with per-row remove and a foot add; controlled; the kit
  owned the row rhythm so no surface hand-rolls it. CSS in
  `styles/components/row-list.css`, exported from `ui/index.ts`, row in
  `ui/README.md`, 7 tests.
- **Connection editor** (`connections.tsx`): a **Forwards** tab with the
  EditableRowList (direction select, bind host, bind port, destination —
  destination hidden for dynamic), add/remove per row, row errors surfaced
  with `role="alert"`, and save gated on `firstForwardError` (mirrors
  `ValidForwards`). The list saves as one `options.forwards` patch (or the
  whole profile on create); an empty list persists as `[]` (explicitly
  none). **Port discovery** select in Advanced (profile + group defaults),
  patch path `options.portDiscovery`, placeholder "— Inherited —".
- **`profiles.ts`**: `portDiscovery?`, `forwards?: ForwardSpec[]`,
  `ForwardSpec`/`ForwardDirection` types.
- **Contract**: `contracts/profiles.effective.schema.json` adds
  `portDiscovery` to the closed `fields` key set (`required` +
  `propertyNames`); renderer types regenerated (`npm run contracts`,
  `contracts:check` green). The generated file is unchanged at the type
  level (fields is an index signature).

## Failure modes covered (brief §"The failure modes")

- Busy local port → `Replay` returns the bind error on that row; tunnel
  record stopped; other rows still start. Tested against a REAL occupied
  listener (EADDRINUSE), not a fake.
- Connector refusal → every row reports its own acquire failure; nothing
  panics/hangs.
- Remote/dynamic stored rows → preserved, reported per-row (D4).
- Policy wording: `Result.Err` carries the strategy's error verbatim; the
  transport renders it (the -R AllowTcpForwarding refusal is the tunnel
  layer's wording, not flattened to "failed").

## Test counts (before → after)

| Suite                                     | Before        | After                                                                                            |
| ----------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `go test -race ./internal/profile/...`    | ~87           | **101** (12 portDiscovery + 7 forwards tests new)                                                |
| `go test -race ./internal/connectfwd/...` | —             | **6** (new package)                                                                              |
| frontend full suite                       | 1825 baseline | **1825 passing, 104 files** (includes +7 row-list, +5 connections.behavior, +7 connections.test) |

## Gates (all run, real exit codes)

- `go build ./...` ✓ · `go vet` (profile, connectfwd) ✓ · `golangci-lint run`
  (profile, connectfwd) ✓ · `gofumpt -l .` → 0 ✓ · `go test -race` scoped ✓
- `tsc --noEmit` ✓ · `npx eslint src/` ✓ (exit 0, unmasked) ·
  `npx prettier --check src/` ✓ · `npm run contracts:check` ✓ ·
  `npm test -- --run` → 104 files / 1825 tests ✓
- `deadcode -filter 'nocx/internal/connectfwd' ./...` → `unreachable func: Replay`
  (expected; wiring is the handoff above)
- `go test ./internal/transport/... -run 'Effective|Patch|Profile'` ✓
  (my schema/field changes did not break the transport's contract tests)

## Files

```
M contracts/profiles.effective.schema.json
M frontend/src/connections.behavior.test.tsx
M frontend/src/connections.test.tsx
M frontend/src/connections.tsx
M frontend/src/profiles.ts
M frontend/src/style.css
M frontend/src/styles/surfaces/connections.css
M frontend/src/ui/README.md
M frontend/src/ui/index.ts
A frontend/src/styles/components/row-list.css
A frontend/src/ui/row-list.test.tsx
A frontend/src/ui/row-list.tsx
A internal/connectfwd/connectfwd.go
A internal/connectfwd/connectfwd_test.go
A internal/profile/forwards_test.go
A internal/profile/portdiscovery_test.go
M internal/profile/profile.go
```

## What I could not verify

- End-to-end connect-time replay (a stored forward actually opening when a
  session comes up) — requires the transport seam above, out of my scope.
- groups.impact diff preview for `portDiscovery` — the impact computation
  lives in transport; the field label map is updated on this side.
- No commit/push/bd made, per brief.
