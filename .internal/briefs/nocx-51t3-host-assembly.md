# Brief — nocx-51t3: the host list must not need a DOM

Supervised worker. Read this whole file first.

## Ground rules

- **No commit, no push, no branch.** **Do not touch `bd`.**
- **No repo-wide gates.** **Do run**, from `frontend/`:
  `./node_modules/.bin/tsc --noEmit`, `npx eslint src/`,
  `npx prettier --check src/`, and `npm test -- --run` for what you touched.
  The type-check is not optional — vitest transpiles without type-checking, and
  a worker in this repo already shipped a file that was green and did not
  compile.
- You own `frontend/src/quick-connect.tsx`, `frontend/src/suggest/` and a new
  module. **Other workers are live in Go packages — stay out of `internal/`.**
- Numbers, not adjectives. Heartbeat each phase.

## Baseline

`npm test` green: 101 files, 1783 tests, ~18s.

## The problem

`nocx-n9i6` routed quick-connect's host assembly into the completion popup
read-only, which was right: two derivations of "which hosts do I know" drift,
and the stale one would be the one in the dropdown that nobody checks.

But `quick-connect.tsx` pulls `solid-js/web`, whose `delegateEvents` crashes at
module load outside a DOM, so a node test cannot import it. The worker worked
around it honestly — the eight specification tests moved to jsdom
assertion-identical, and `providers.ts` **injects** the host provider rather
than importing it — and left two costs behind:

1. the degraded-resolver condition travels as a **sentinel label** that has to
   be parsed back out, instead of being typed data;
2. the tests need a DOM they do not otherwise use.

## What to build

Extract the assembly into a plain, non-UI module both sides import: the
profiles-plus-aliases list, **including** the dedup of an alias a saved profile
already targets, and the degraded-resolver condition **as typed data** rather
than a label string.

Then `host-provider.test.ts` returns to the node environment and `providers.ts`
imports the provider instead of receiving it by injection.

**Do not change behaviour.** This is a move, and the existing tests are the
proof it was faithful: if an assertion has to change, that is a signal you
changed semantics — say so explicitly rather than adjusting the test quietly.

## Test first

The existing tests already specify this. Run them before and after and report
both counts. Add one assertion the old shape could not make: that the degraded
condition is readable as data without parsing a human-facing string.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, test counts before/after, any assertion you had to change and why, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<phase>" --json
```
