# nocx-n9i6 — `ssh <TAB>` offers hosts: completion report

Dispatch `ctx_37ec3877a1b1` / task `task_f82b2e4124a5`, worktree `sshcomp`.

## What shipped

`ssh <TAB>` now offers hosts: the same profiles-plus-aliases list quick-connect
assembles, routed read-only through `SSHQuickConnectProvider` +
`SSHAliasQuickConnectProvider` (host-provider.ts) — WITH the alias-suppression
dedup (an alias covered by a saved profile appears once, from the profile) and
WITH the degraded-resolver surfacing (an unavailable `ssh -G` becomes the
`hosts-unavailable` empty reason, never an empty list; profiles still answer
on their own when the resolver is degraded).

- Applicability: the `ssh` command, argument position only, no `/` in the
  token. `ls ` offers nothing; `ssh some/path` completes a path.
- Ranking: hosts share the argument-position token rung with paths (above
  whole-line history whatever its recency) and get provider prior 3, so a
  same-quality path tie breaks to the host. Registered above history in
  `createShellProviders`.
- Badge: `host` source badge in the dropdown; the row shows the picker's
  label (`user@host` / alias) as display AND insert text.
- Ghost text: `ssh <TAB>` ghosts the full host; a mid-label match (typed
  `myh` against `root@myhost`) declines the ghost honestly rather than
  overlapping what is on screen.

## Files

- `frontend/src/suggest/host-provider.ts` (new) — the provider; instantiates
  the quick-connect classes read-only (run callbacks unreachable), reads
  labels, recovers the degraded reason off the sentinel row's label
  (`SSH config: ` prefix).
- `frontend/src/suggest/host-provider.test.ts` (new, jsdom) — the 8 spec
  tests, assertions byte-identical to the predecessor's.
- `frontend/src/suggest/candidate.ts` — `CandidateSource` gains `'host'`.
- `frontend/src/suggest/providers.ts` — `EmptyReason` gains
  `hosts-unavailable {reason, detail}`; `commandWord` exported (the fs
  provider's own derivation, reused for the ssh gate);
  `createShellProviders` gains an injected `hostProvider?` registered above
  history.
- `frontend/src/suggest/rank.ts` — `ARGUMENT_PATH_RUNG` → `ARGUMENT_TOKEN_RUNG`
  covering path + host; `PROVIDER_PRIOR` gains `host: 3`.
- `frontend/src/suggest/controller.ts` — `hosts-unavailable` in the reason
  priority map and the empty-row message (`SSH config: <reason> — <detail>`).
- `frontend/src/suggest/rank.test.ts` — golden case: a host outranks
  whole-line history in argument position whatever its recency.
- `frontend/src/ui/completion-dropdown.ts` / `.test.ts` — `host` source badge
  - badge test.
- `frontend/src/terminal-content.ts` — constructs `hostProvider` at the
  composition root with this tab's ProfileClient (minimal edit, 7 lines).

## Deviation from the brief — the test move, and why

The brief's "read-only dependency" first cut is what shipped, but the tests
had to move out of `providers.test.ts` (node): importing `quick-connect.tsx`
pulls `ui/dialog.tsx` → `solid-js/web`, whose `delegateEvents` runs at module
scope and throws `ReferenceError: window is not defined` under node. A
node-env test physically cannot load the routed assembly, so the 8 host tests
live in `host-provider.test.ts` with `// @vitest-environment jsdom`,
assertions unchanged. `providers.test.ts` is back to byte-identical with HEAD
(the predecessor's additions were uncommitted, so the file shows no diff).

The consequence: `providers.ts` MUST NOT statically import host-provider.ts
(that chain is node-hostile and `providers.test.ts` is node). The host
provider is therefore INJECTED into `createShellProviders` and constructed in
`terminal-content.ts`, where the ProfileClient lives.

## For the coordinator — the shared-assembly extraction is still owed

The assembly (labeling, alias-suppression dedup, degraded row) still lives
inside `quick-connect.tsx`'s classes; host-provider.ts is a read-only consumer
and currently recovers the degraded reason by parsing the sentinel row's label
(`SSH config: ` prefix) because the reason code is not a field on the item.
The brief's longer-term move — lifting the assembly into a shared non-UI
module that quick-connect's classes AND host-provider both call — is
unchanged and should be sequenced; it will remove the label-parse coupling and
let the host tests return to the node suite. I did not touch `quick-connect.tsx`
or `profiles.ts` (the other worker owns them).

## Verification

- `tsc --noEmit`: clean.
- `eslint src/`: clean. `prettier --check src/`: clean.
- Full frontend suite: 101 files, 1783 tests, all green (baseline was 100
  files / 1773 tests; +8 host, +1 rank, +1 badge — the moved host tests were
  in the predecessor's uncommitted work and are now counted in the new file).
- Could not verify in a live browser (no wails/devharness run per the brief);
  behavior is pinned by the provider, rank, dropdown and controller tests.
