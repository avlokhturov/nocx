# Brief — nocx-n9i6: `ssh <TAB>` must offer hosts

You are a supervised worker. Read this whole file before touching anything.

## Ground rules

- **Do not commit, push, or create a branch.** The coordinator integrates.
- **Do not touch `bd`.** Beads lives in a Dolt database git does not carry.
- **Do not run repo-wide gates.** **Do run**, from `frontend/`:
  `./node_modules/.bin/tsc --noEmit`, `npx eslint src/`, `npx prettier --check src/`,
  and `npm test -- --run` for the files you touched. The type-check is not
  optional — vitest transpiles without type-checking, so a green suite can sit
  on a file that does not compile.
- You own `frontend/src/suggest/` and its tests. **Another worker is editing
  `frontend/src/quick-connect.tsx` and `frontend/src/profiles.ts` in a separate
  worktree — do not edit those two.** You may *read* them; you will need to.
  If you both need `main.tsx`, keep your edit minimal and say so in your report.
- Report **numbers, not adjectives**. Heartbeat at every phase change.

## Baseline

`npm test` green: 100 files, 1773 tests, ~18s.

## The gap

`CandidateSource` in `frontend/src/suggest/candidate.ts:10` is
`'command' | 'history' | 'path'`. There is no host source, so typing `ssh ` and
asking for completion offers shell history and filesystem paths — the two things
that are never the answer in that position.

The owner asked for exactly this, and named the source: *completion for the ssh
command, showing what quick connect shows*.

## The data already exists — route it, do not rebuild it

`frontend/src/quick-connect.tsx` already assembles this list:

- saved profiles via `profileClient.listProfiles()`;
- live `~/.ssh/config` aliases via `profileClient.listSSHAliases()`;
- **deduplication** — an alias already targeted by a saved profile is suppressed,
  because the profile is ours and wins (`quick-connect.tsx:172`);
- a **degraded resolver** is surfaced rather than hidden (`:155`) — when
  `ssh -G` cannot answer, the picker says so instead of showing an empty list.

Two independent derivations of "which hosts do I know" will drift, and the
version in the completion popup would be the one nobody notices is stale. Share
the assembly. If that means lifting it out of `quick-connect.tsx` into a module
both can call, **say so in your report** — the other worker owns that file, so
the coordinator sequences the move rather than you racing it. A read-only
dependency on what is there today is the safer first cut.

## Scope it to the position, not the word

The provider must apply **only** where a host is the answer: the `ssh` command,
in its argument position. `ls ` must not offer hosts, and neither must `ssh` in
the middle of a path argument. `frontend/src/suggest/providers.ts` shows how the
existing providers gate applicability (`fsProvider`'s rules are the model), and
`token.ts` is what tells you where the cursor is.

Rank hosts **above** history in that position. In `ssh <TAB>` a previously-run
command line is a worse answer than a host you have configured, and the existing
`MAX_HISTORY_IN_ARGUMENT_POSITION` cap (`providers.ts:30`) exists because
history was already crowding better answers elsewhere.

Give the source its own badge, the way `completion-dropdown` already
distinguishes `Directory` / `File` and its source badges — a host and a path
must not look alike in the same list.

## Test first

Red before green. `providers.test.ts` and `controller.test.ts` are the seams.
Assert: `ssh ` offers hosts; `ssh myh` filters them; `ls ` offers **none**;
a host already covered by a saved profile appears once, from the profile; an
unavailable `ssh -G` resolver surfaces the condition rather than an empty list;
and hosts outrank history in that position.

## When you are done

```bash
orca orchestration send --type worker_done --subject "<one-line status>" \
  --body "<what changed, test counts before/after, whether the host assembly is shared or duplicated and why, anything you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
```

```bash
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<reading|red|green|verifying>" --json
```
