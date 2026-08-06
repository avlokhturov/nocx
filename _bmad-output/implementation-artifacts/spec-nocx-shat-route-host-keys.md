---
title: 'Route-specific SSH host keys'
type: 'bugfix'
created: '2026-08-06'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'b508c69ff6b20e9e9ad4dd5fe2738c82317a60b1'
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/architecture.md'
  - '{project-root}/frontend/src/ui/README.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A target hostname may legitimately resolve to different servers on the direct route and through a jump host. nocx currently checks both against one `known_hosts` identity, so accepting either key breaks the other route; an open-time host-key error also does not complete the existing consent-and-retry flow safely.

**Approach:** Keep direct-route OpenSSH-compatible host identities, but give every jump route a stable, opaque `known_hosts` identity derived from the target endpoint plus the full jump-host chain. Carry that identity as backend-issued trust evidence, require explicit user consent for unknown and changed keys, and retry the exact failed open after a successful trust write.

## Boundaries & Constraints

**Always:** Verify target and every jump host independently; preserve direct-route `known_hosts` entries; derive route identity only from endpoint routing, never credentials; keep changed-key acceptance explicit and dangerous; carry public host-key material only; keep the existing JSON-RPC control plane and generated contract workflow.

**Ask First:** Any migration or deletion of existing user `known_hosts` entries beyond replacing the explicitly accepted route identity.

**Never:** Auto-trust an unknown or changed key, use the jump host's key as the target's key, key trust by credential/profile identity, route PTY bytes through JSON-RPC, or silently fall back from a configured jump route to direct dialing.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Direct and jump coexist | Same target hostname presents key A directly and key B through jump | Direct lookup accepts A; jump-route lookup accepts B; neither replaces the other | Unknown route raises consent before its first write |
| Changed jump target key | Existing route entry B, route presents C | UI names C and stored B; only explicit danger action replaces B for that route | Decline writes nothing and does not retry |
| Open encounters unknown key | Session open returns backend host-key evidence | Existing dialog asks for consent; successful trust retries the exact requested open | Trust or retry failure remains visible and recoverable |
| Multi-hop route | Same target through distinct full jump chains | Each chain has an independent stable identity | Missing/invalid evidence never triggers a write |

</frozen-after-approval>

## Code Map

- `internal/ssh/ssh_real.go` -- `known_hosts` callback, route identity, trust write.
- `internal/ssh/ssh_dial.go` -- installs target callback with route context; jump callbacks remain hop-specific.
- `internal/ssh/ssh_probe.go` -- probe uses the same route identity as open.
- `internal/ssh/errors.go` -- backend-issued display and lookup identities in host-key evidence.
- `internal/transport/ws_probe.go` -- exact host-key wire result used by probe and open error paths.
- `contracts/connections.probe.schema.json` -- canonical renderer contract.
- `frontend/src/terminal-content.ts` -- open-time host-key evidence and retry lifecycle.
- `frontend/src/main.tsx`, `frontend/src/tabs.ts` -- preserve all SSH recovery hooks.
- `frontend/src/connections.tsx` -- consent dialog and trust call use display/lookup identities correctly.

## Tasks & Acceptance

**Execution:**
- [x] Add failing SSH tests proving direct and jump entries coexist and distinct jump chains do not collide.
- [x] Implement a stable route-specific target lookup identity shared by Connect and Probe without changing jump-host verification.
- [x] Extend host-key evidence and schema with the backend-issued `knownHostsHost`; regenerate TypeScript types.
- [x] Make unknown and changed open-time failures enter the existing consent dialog and retry the failed open only after trust succeeds.
- [x] Preserve vault unseal and setup hooks while wiring host-key recovery; add behavior regressions.

**Acceptance Criteria:**
- Given target key A is trusted directly and key B is trusted through a jump route, when either connection is opened repeatedly, both succeed without replacing or rejecting the other's entry.
- Given an unknown or changed key appears during session open, when the user declines, no trust write and no retry occurs; when the user accepts, the route identity from backend evidence is written and that open is retried.
- All affected schemas, Go DTOs, generated TypeScript, and real-socket contract tests agree exactly.

## Spec Change Log

- 2026-08-06: Adversarial review found three candidates. Patched concurrent duplicate consent so one successful trust write resolves every queued request for the identical route identity and key. Deferred the pre-existing direct-host wildcard replacement gap to `deferred-work.md`. Rejected a retry-cap suggestion because every repeated host-key decision requires fresh explicit user consent and may represent a genuinely different newly offered key.

## Design Notes

A jump target lookup name is an opaque hostname-safe digest of a versioned route descriptor: target address plus each configured jump endpoint in route order. The real target address remains the displayed host and dial address. This separates storage identity from user-facing endpoint identity without exposing credentials or making trust depend on mutable profile IDs.

## Verification

**Commands:**

- `CGO_ENABLED=1 go test -race ./internal/ssh ./internal/transport ./internal/session` -- transport and session passed; the first SSH run hit `TestDiscoveryConn_Close_MidExec_StopsRemoteExec`, then `CGO_ENABLED=1 go test -race ./internal/ssh` passed on immediate rerun.
- `cd frontend && npm run contracts:check` -- generated contracts match.
- `cd frontend && npm run typecheck && npx eslint . && npx prettier --check .` -- frontend static gates pass.
- `cd frontend && npx vitest run src/host-key-controller.test.ts src/terminal-content.test.ts -t 'OpenHostKeyRequestQueue|SSH open host-key recovery'` -- queue deduplication and open retry/decline behavior pass.
- `cd frontend && npx vitest run src/connections.behavior.test.tsx -t 'unknown host key|changed host key'` -- Connections consent behavior passes.
- `npx playwright test e2e/connection-password.spec.ts --project=chromium` with isolated `NOCX_E2E_HOME_DIR` and headless backend -- both password-reuse and unknown-host consent journeys pass.
- `gofumpt -l . && golangci-lint run` -- Go formatting and lint pass.
- `CGO_ENABLED=1 go test -race ./...` -- blocked by workstation/test-suite prerequisites: `dash` is absent from `PATH`; unrelated SSH close/tunnel flakes also failed in the full run.
- `cd frontend && npm test` -- 1132 tests passed; the full run has two unrelated failures: Shiki highlighter initialization in `scrollback/blocks.test.ts` and missing jsdom `localStorage` in `sidebar.test.tsx`.
- `wails build -tags webkit2_41` -- desktop binary builds at `build/bin/nocx`.

## Review Findings

- **Patched:** simultaneous opens for the same route/key no longer show redundant consent dialogs; queued duplicates retry after the first successful trust write.
- **Deferred:** wildcard direct-host entries are not removed when accepting a specific replacement key; recorded in `deferred-work.md`.
- **Rejected:** an open retry cap would incorrectly suppress explicit consent for a genuinely different key offered after trust; the loop cannot advance without a user decision.

## Suggested Review Order

**Route identity and enforcement**

- Stable route digests separate jump trust without exposing credentials or profile IDs.
  [`ssh_real.go:327`](../../internal/ssh/ssh_real.go#L327)

- Every direct and jump dial applies the backend-owned storage identity.
  [`ssh_dial.go:174`](../../internal/ssh/ssh_dial.go#L174)

**Wire evidence and consent**

- Probe results carry exact storage identity and backend-classified key state.
  [`ws_probe.go:113`](../../internal/transport/ws_probe.go#L113)

- Open failures are runtime-narrowed, explicitly approved, then retried unchanged.
  [`terminal-content.ts:124`](../../frontend/src/terminal-content.ts#L124)

- Serialized decisions preserve tab ownership and deduplicate identical queued keys.
  [`host-key-controller.ts:12`](../../frontend/src/host-key-controller.ts#L12)

- One kit-based dialog serves both probe-time and open-time consent.
  [`host-key-dialog.tsx:21`](../../frontend/src/host-key-dialog.tsx#L21)

**Regression proof**

- Filesystem tests prove direct and jump identities coexist across credential changes.
  [`trust_host_key_test.go:136`](../../internal/ssh/trust_host_key_test.go#L136)

- Browser journey observes unknown-key consent before authentication and successful retry.
  [`connection-password.spec.ts:294`](../../e2e/connection-password.spec.ts#L294)
