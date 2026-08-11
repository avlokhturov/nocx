---
title: 'Port structured Backup & Restore onto current main'
type: 'feature'
created: '2026-08-09'
status: 'done'
baseline_commit: 'bc603c6f261f3c51f9f382388f8778333ce1d068'
context:
  - '{project-root}/docs/architecture.md'
  - '{project-root}/docs/capabilities-migration-map.md'
  - '{project-root}/docs/decisions/0011-persistence-storage-capabilities-and-secret-references.md'
  - '{project-root}/docs/decisions/0018-contentdb-engine-and-encryption-at-rest.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** PR #61 implements structured Backup & Restore against an older transport and profile model. Current main has since moved JSON-RPC dispatch to validated `methodSpec` registrations, added capability operations, and made SSH options presence-aware; applying the PR as a merge leaves conflicts, stale APIs, and either a non-building or data-loss-prone feature.

**Approach:** Port the PR's v1 `nocx-backup` document, merge/replace preview-confirm-restore workflow, crash-recovery journal, native save dialog, UI surface, and wire contracts onto current main. Replace the legacy `export.*` surface cleanly, adapt every non-secret connection field (including current presence-aware delivery and forwarding options), and register backup handlers through the current responder/capability control plane.

## Boundaries & Constraints

**Always:** Keep credentials and secret values out of backup documents and restore paths; preserve credential references/metadata on existing profiles; use one composition-root dependency graph; keep handlers off the WebSocket read loop; use bounded control admission and `Responder`; make restore atomic per store with `prepared -> committed -> idle` recovery; validate exact JSON-RPC results with schemas and over-the-wire tests; expose soft degradation visibly in the UI.

**Ask First:** None anticipated; stop only if current main contains a deliberate incompatible ADR or a required store cannot provide the atomic snapshot seam.

**Never:** Do not resolve secrets, wrap PTY bytes in JSON-RPC, retain duplicate legacy export owners, add compatibility aliases for old RPCs, silently drop current non-secret profile fields, hand-edit generated frontend contract types, or bypass the current method registry with a `switch` handler.

## I/O & Edge-Case Matrix

| Scenario        | Input / State                                 | Expected Output / Behavior                                                          | Error Handling                                           |
| --------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| HAPPY_PATH      | Live profiles/groups/settings                 | `backup.create` returns bounded JSON and summary; UI saves it                       | Internal errors become JSON-RPC error and visible toast  |
| PREVIEW         | Valid backup plus `merge` or `replace`        | `backup.preview` returns exact diff, omissions, credential requirements, token      | Invalid document/strategy is `-32602`; no store mutation |
| STALE_CONFIRM   | State changes after preview                   | `backup.restore` refuses stale token and requires re-preview                        | No partial write                                         |
| RESTORE_FAILURE | Failure during settings/profile/journal phase | Recovery journal remains actionable; next startup repairs or poisons config visibly | `-32603`; no silent success                              |
| LIMIT           | Invalid JSON or content over 8 MiB            | Request rejected before unbounded parsing/storage                                   | `-32602`                                                 |

</frozen-after-approval>

## Code Map

- `internal/backup/` -- document schema, snapshot conversion, diff/restore service, journal, native save dialog.
- `internal/profile/profile.go`, `internal/profile/store.go` -- presence-aware non-secret connection snapshot and atomic replacement seam.
- `internal/settings/settings.go` -- non-secret override snapshot, replacement, deferred notifier.
- `internal/capability/` -- typed backup operation and guarded domain service boundary.
- `internal/transport/registration.go`, `internal/transport/ws.go`, `internal/transport/ws_backup.go` -- current responder-based registrations, options, handler adapters, and admission wiring.
- `internal/app/app.go` -- composition-root wiring and startup recovery.
- `contracts/backup.*.schema.json`, `frontend/src/generated/` -- exact wire contracts and generated types.
- `frontend/src/backup-file.ts`, `frontend/src/backup-restore-section.tsx`, `frontend/src/profiles.ts`, `frontend/src/settings.tsx`, `frontend/src/ui/file-input.tsx` -- client API, UI flow, and file input.
- `e2e/` -- user-path acceptance coverage through the real backend.

## Tasks & Acceptance

**Execution:**

- [x] Add backup document/service/journal/save-dialog code and tests, adapted to current profile/settings models -- preserve all non-secret fields and recovery invariants.
- [x] Add profile/settings snapshot seams and atomic implementations -- make backup reads and writes coherent without exposing secrets.
- [x] Add typed capability operation and current `methodSpec` registrations -- keep handlers responder-only and bounded off-loop.
- [x] Replace legacy export RPC/package/callers and wire the service in `internal/app/app.go` -- leave one owner for backup behavior.
- [x] Add four exact backup JSON Schemas and generated frontend types plus contract checks -- make the wire a tested party.
- [x] Port the Backup & Restore UI and file-input behavior -- make create/save/preview/confirm/restore reachable from Settings.
- [x] Add backend over-the-wire and frontend/e2e happy-path and failure-path tests -- prove the user can create, save, preview, and restore.
- [x] Harden native save and JSON parsing -- pass filenames as data, detect duplicate keys token-by-token, and make nested values return validation errors rather than panic.
- [x] Validate the complete restored aggregate through existing settings/profile authorities -- reject unknown settings, malformed forwards, and orphaned group references before mutation; normalize session-end behavior.
- [x] Restore transport and UI contracts -- keep the Tabby document budget, represent save cancellation exactly on the wire, publish inline rollback notifications, and compose Backup & Restore from PageSection so WebKit scroll ownership remains intact.
- [x] Replace no-op acceptance coverage with non-empty restore and restart assertions; add regression tests for every review reproducer.

**Acceptance Criteria:**

- Given current main, the backend and frontend build without merge markers or stale export symbols.
- Given a configured user, Settings can create and save a structured backup, load it, preview merge/replace, and restore after confirmation.
- Given credential-bearing profiles, the backup contains no credential IDs or values and restore preserves existing credential metadata while reporting reassignments/omissions.
- Given malformed, oversized, stale, or failing restores, no silent partial success occurs and the UI exposes the error/recovery state.
- Given a real WebSocket connection, each `backup.*` result validates against its schema; targeted e2e exercises the complete flow.

## Spec Change Log

## Verification

**Commands:**

- `go test ./internal/backup ./internal/capability ./internal/transport ./internal/app` -- expected: PASS.
- `go test ./...` -- expected: PASS.
- `npm run contracts:check` -- expected: PASS.
- `npm run typecheck` and `npm test` in `frontend/` -- expected: PASS.
- Targeted `e2e` backup spec in the disposable harness -- expected: create/save/read/preview/restore succeeds.

## Suggested Review Order

**Restore invariants**

- Restore coordinates preview freshness, journal spans, rollback, and deferred notification publication.
  [`service.go:189`](../../internal/backup/service.go#L189)

- One parser validates duplicates, settings, forwards, groups, and document shape before mutation.
  [`service.go:577`](../../internal/backup/service.go#L577)

- Atomic profile replacement enforces group membership and the existing forward authority.
  [`store.go:399`](../../internal/profile/store.go#L399)

- Registry validation makes preview and restore accept exactly the same non-secret values.
  [`settings.go:1036`](../../internal/settings/settings.go#L1036)

- Merge normalizes duplicated session-end fields while preserving current credential metadata.
  [`service.go:1215`](../../internal/backup/service.go#L1215)

- Recovery publishes rolled-back settings only after the profile snapshot is restored.
  [`service.go:250`](../../internal/backup/service.go#L250)

**Native save and wire boundaries**

- macOS passes filenames as argv data, removing AppleScript interpolation entirely.
  [`save.go:126`](../../internal/backup/save.go#L126)

- Document admission retains the 8 MiB budget for backup and Tabby imports.
  [`ws.go:1327`](../../internal/transport/ws.go#L1327)

- Cancellation is explicitly nullable while successful save results remain exact objects.
  [`backup.saveToFile.schema.json:1`](../../contracts/backup.saveToFile.schema.json#L1)

- Real-socket coverage validates both cancellation and successful save against the schema.
  [`ws_backup_contract_test.go:112`](../../internal/transport/ws_backup_contract_test.go#L112)

**Renderer lifecycle and layout**

- Backup cards compose PageSection, preserving the Settings page's sole scroll owner.
  [`backup-restore-section.tsx:199`](../../frontend/src/backup-restore-section.tsx#L199)

- One observer fans invalidations to independent application and Settings consumers.
  [`settings-observer.ts:32`](../../frontend/src/settings-observer.ts#L32)

- Composition-root injection gives the Settings surface a scoped observer cleanup.
  [`main.tsx:245`](../../frontend/src/main.tsx#L245)

**Acceptance proof**

- Real WebSocket acceptance mutates, restores, restarts, and re-reads profiles and settings.
  [`backup_acceptance_test.go:11`](../../internal/app/backup_acceptance_test.go#L11)

- Browser acceptance saves the download, mutates state, restores, and observes the setting.
  [`backup-restore.spec.ts:9`](../../e2e/backup-restore.spec.ts#L9)
