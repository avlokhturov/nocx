# W5 contracts — completion report (task_42d4170adc2f)

## Delivered

- **7 schemas** under `contracts/`: `files.open`, `files.list`, `files.read`,
  `files.watch`, `files.close`, `files.reveal` (result shapes) and
  `files.changed` (the notification).
- **7 generated files** under `frontend/src/generated/`: `files.*.ts`, produced by
  `cd frontend && npm run contracts`, no hand edits.

## Gates (exact output)

- `npm run contracts` — regenerated all 44 generated files; the 7 new ones added.
- `npm run contracts:check` — exit 0, no `stale:` lines (existing generated files
  byte-identical after regeneration; `git status` shows only the 14 new files, zero
  modified).
- `./node_modules/.bin/tsc --noEmit` — exit 0, repo-wide. No errors in my generated
  files, none elsewhere.

Every schema has `additionalProperties: false` (per closed object, see A1) and an
explicit `required` list. `entries` is never nullable; `Kind` is an enum
`["regular","dir","symlink","other"]`; `canonical` is required on `files.list` (all
branches that return a listing) and `files.read`; `endpointId` is required
`["string","null"]`; `files.close`/`files.reveal` declare `{}` with
`additionalProperties: false` and `required: []`; `files.changed` carries
`{bindingId, path, rev?}` and never entries.

## Ambiguities where §5.2 was not explicit — choices made, all documented in the schemas' descriptions so the Go worker implements the exact encoding

1. **`files.list` discriminator.** The §5.2 table lists `tooLarge`/`timedOut` as
   "or" alternatives without naming a discriminating field. I added a top-level
   `state` field: `"ok" | "tooLarge" | "timedOut"`, modeled as a `oneOf` of three
   closed branches (first `oneOf` in this directory). The normal branch therefore
   carries `state: "ok"`, a field the table does not list — the brief's
   "discriminating field" requirement outweighs literal table fidelity. Generated
   TS is a discriminated union that narrows on `state`.
   **A1 corollary:** `additionalProperties: false` cannot sit at the top level of a
   `oneOf` schema — with no top-level `properties` it would forbid every branch
   property, making the schema unsatisfiable. Each branch carries its own
   `additionalProperties: false` + `required`, so every accepted object is closed.
   A naive gate that checks only the root object will not see it; the branches are
   where the closure lives.
2. **`observedCount` on `tooLarge`.** §5.1 says it is reported "only when a complete
   enumeration was actually paid for". Modeled **optional** (absent = "more than N"),
   not nullable-required: 0 is impossible in the tooLarge state (count exceeds the
   cap), so an omitted key is unambiguous. A null is never sent for it.
3. **`linkTarget`/`linkKind` on entries.** §5.1's struct says "symlinks only"
   (plain string, omitempty). Modeled **optional, present only when `kind` is
   `'symlink'`, never null** — weaker than required+nullable, deliberately: the
   brief did not call for null here, and required+nullable would force the Go DTO
   into pointer fields, a mapping cost the contracts README says this seam hasn't
   earned. Descriptions state the rule exactly.
4. **`files.watch` `mode` values.** The spec pins `'polling'` literally (§5.5) and
   describes the other as live watching; I chose the closed enum
   `["watching", "polling"]`. `degradedReason` is **optional** — present exactly
   when a local watch could not be established and the backend fell back to
   polling; absent for the designed modes (healthy local, remote polling), because
   "designed-mode polling warns about nothing" and a remote binding is never
   degraded.
5. **`timeout` units.** §5.2 does not state them. Chose **milliseconds**, matching
   this repo's duration-on-the-wire convention (history's Unix-ms timestamps);
   documented in the schema.
6. **`modTime` encoding.** Chose **ISO-8601 UTC** with `format: date-time` —
   repo precedent (`ports.sample.lastSampleAt` is "ISO-8601 UTC time",
   `shell.footprint.status.lastObservedAt` uses `format: date-time`).

## Not done (out of scope by brief)

Go DTO + over-the-wire conformance tests (`ws_contract_test.go`), the client
re-export, beads, commits. Work left uncommitted as instructed.
