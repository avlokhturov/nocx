# W3 — dead-code ratchet: report

Built the baseline-ratchet gate for both languages, following the existing
`frontend/lint-fixtures` mechanism (checker + committed baseline + update script
with growth guard). Uncommitted, per ground rules.

## Files (all new unless marked M)

- `.githooks/check-deadcode.mjs` — Go checker: runs `deadcode ./...` from repo
  root, parses `file:line:col: unreachable func: name`, diffs against baseline,
  exits 1 only on un-baselined (new) violations or tool failure.
- `.githooks/deadcode-baseline.json` — 86 baselined unreachable functions.
- `.githooks/update-deadcode-baseline.mjs` — regeneration; refuses growth.
- `M .githooks/pre-commit` — `check_cmd deadcode` (install hint) + RUN_GO-gated
  gate after golangci-lint.
- `frontend/knip.json` — real entry points: index.html, src/main.tsx, vite +
  vitest configs, eslint.config.js, scripts/_.mjs, lint-fixtures/_.mjs.
- `frontend/lint-fixtures/check-dead-exports.mjs` — TS checker: runs local knip
  `--reporter json --no-exit-code`, gates unused files/exports/types only.
- `frontend/lint-fixtures/dead-exports-baseline.json` — 134 baselined violations.
- `frontend/lint-fixtures/update-dead-exports-baseline.mjs` — regeneration;
  refuses growth.
- `M frontend/package.json` — `lint` chain gains `check-dead-exports.mjs`;
  new `lint:dead-exports`, `baseline:dead-exports-update` scripts; `knip`
  devDependency (6.0 MB, 60 new lockfile entries; zero existing packages'
  versions changed — verified by diffing lockfile version maps).
- `M frontend/package-lock.json` — knip tree only.

## Numbers

| Measurement                            | Value                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| deadcode, plain `./...`                | **86** unreachable funcs (93 incl. flatted Go in node_modules — filtered by the checker; 9 with `-test`, informational) |
| knip zero-config (6.32.0)              | 118 unused exports, 70 types, 29 files, 1 dep, 1 devDep, 3 unlisted                                                     |
| knip with knip.json                    | 53 exports, 70 types, 11 files = **134** baselined (+5 dep items, informational only)                                   |
| Hook wall time, before (HEAD worktree) | 65.6 s (rc=1: transport test flake), 55.8 s (rc=1: flake + vitest tinypool race)                                        |
| Hook wall time, after (ratchet wired)  | **52.7 s, rc=0, all gates green**                                                                                       |

The two new gates cost ~4.3 s (deadcode) + ~1 s (knip); both run inside the
shadow of the container gates (started at step 1), so the wall impact is
absorbed. The container flakes (2 s notification i/o timeout in
`internal/transport`, tinypool module race) are pre-existing at HEAD — the
before-runs hit them, not my change.

## Verification (each proven, then reverted)

1. Both checkers exit 0 on the current tree with generated baselines. ✔
2. Deliberate new violation (temp probe, removed after):
   - Go: `zz_ratchet_probe.go` → rc=1, `87 unreachable functions (86 baselined,
1 NEW): NEW: zz_ratchet_probe.go: ratchetProbeUnreachable`; removed → rc=0.
   - TS: `src/__ratchet_probe__.ts` → rc=1, `135 violations (134 baselined,
1 NEW): NEW: src/__ratchet_probe__.ts`; removed → rc=0.
3. Baseline-entry removal:
   - Legit shrink (code fixed, stale entry remains): rc=0, "baseline shrunk by
     1"; update script rewrites the shrink.
   - Evasion (entry removed while the violation still exists): rc=1 — the
     checker treats it as a new violation; that is the anti-evasion property.
4. Growth guards: both update scripts refuse growth (rc=1, REFUSING message)
   with a probe present.
5. `npm run lint` (full chain incl. knip): rc=0, 11.5 s.
6. Full pre-commit hook end-to-end with ratchet: rc=0 (see timing above).

## What neither half catches (documented in both checker headers)

`restoreDescriptor` (tabs.ts:456, tabs.ts:504, main.tsx:226,
state/tab-model.ts:255) is a member of a reachable object, read nowhere —
deadcode asks reachability, knip asks export-consumption, neither sees a member
that is written but never read. The gate is a floor; the AGENTS.md happy-path
criterion stays.

## Notes

- `-test` comparison: `deadcode -test ./...` reports 9 (the rest are test-only
  helpers). The committed baseline uses the brief's exact 86-command; the
  -test number is documented in the checker header, not baselined.
- Prettier was run on my 4 new .mjs files only — the hook's `prettier --check`
  gate fails on unformatted frontend files, so the deliverable must conform;
  `git status` shows no other file touched.
- `frontend/package.json.md5` is stale and has no consumer (pre-existing;
  matches neither HEAD nor current package.json).
