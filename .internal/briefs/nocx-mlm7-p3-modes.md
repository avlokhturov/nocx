# P3 — destination modes replace the policy enum (`nocx-i710`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first, then §2 (N1, N3) and
§3.5 of
[`../specs/2026-08-05-nocxify-delivery-modes-design.md`](../specs/2026-08-05-nocxify-delivery-modes-design.md).

## What you build

The setting a user chooses per destination, and the two things it must never be confused
with.

Today one enum does three jobs. `ShellIntegrationPolicy = 'auto' | 'ask' | 'off'` in
`frontend/src/capability.ts` (mirrored in `internal/profile/profile.go`) answers "may nocx
integrate?", while `Delivery = 'launcher' | 'in-band' | 'relay'` answers "by what carrier?",
and `deriveActions` barely reads either. The owner's decision — **wrap and install
automatically, ask only for the relay binary** — makes the old middle value meaningless.

Three axes, never collapsed:

| axis | values | who owns it |
|---|---|---|
| desired mode | `raw` \| `script` \| `relay` | profile / group / global, through the existing cascade |
| observed delivery | `none` \| `bootstrap-script` \| `installed-script` \| `relay` | the renderer, from what happened this session |
| relay consent | `unknown` \| `granted` \| `denied` | persisted per destination; script mode never reads it |

**Default is `script`.** `raw` refuses every rewrite and every remote write. `relay` is
inert in this epic beyond needing consent to be `granted`.

**No migration.** nocx is greenfield: there is no compatibility value, no import of an old
setting, no "if the profile still says `ask`" branch anywhere. Delete the old enum.

## Files you own

- `internal/profile/profile.go` and the profile resolver + their tests
- `frontend/src/capability.ts`, `frontend/src/connections.tsx` + their tests
- `contracts/open.*`, `contracts/profiles.effective.*`, the generated TypeScript, and the
  conformance tests on both sides

**One shared file, one small edit:** you may make the *minimal* adaptation inside
`frontend/src/terminal-content.ts` needed to keep it compiling against the new enum — the
policy check at submit. Nothing else in that file. After your change it belongs to P9 alone,
so keep the edit small enough to describe in one sentence in your `worker_done`.

Do not touch `ssh-transition.ts` (P4), the ledger or scrollback (P5), or anything in
`internal/shellintegration/` (P1, P2).

## What must be true when you are done

- the three axes exist as distinct types and no function collapses them into one value.
- a table-driven test proves the cascade: profile → nearest group → ancestors → global →
  hardcoded default, for each of the three modes.
- default `script`; `raw` refuses rewrite and remote writes; `relay` without
  `consent=granted` behaves as `raw`.
- `contracts/open` and `contracts/profiles.effective` carry the new shape with
  `additionalProperties: false` and an explicit `required`; the generated TypeScript is
  committed, `npm run contracts:check` passes for those two, and **both** conformance tests
  exist — the DTO one and the one that validates the real result off the real socket.
- the connection UI offers the three modes with honest labels, and a relay selection makes
  the consent state visible rather than silently pretending to be granted.
- no occurrence of `'auto'`, `'ask'` or `'off'` as a shell-integration policy value remains
  in the tree.

## Verify

`go build ./...`, `go vet ./internal/profile/`, `go test -race ./internal/profile/...` and
the transport tests for the two contracts you touched; `cd frontend &&
./node_modules/.bin/tsc --noEmit`; vitest scoped to your files.
