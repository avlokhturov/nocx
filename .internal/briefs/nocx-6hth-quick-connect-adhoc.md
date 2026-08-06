# Brief — nocx-6hth: quick connect must connect to a host you just typed

You are a supervised worker. Read this whole file before touching anything.

## Ground rules

- **Do not commit, push, or create a branch.** The coordinator integrates.
- **Do not touch `bd`.** Beads lives in a Dolt database git does not carry.
- **Do not run repo-wide gates.** **Do run**, from `frontend/`:
  `./node_modules/.bin/tsc --noEmit`, `npx eslint src/`, `npx prettier --check src/`,
  and `npm test -- --run` for the files you touched. The type-check is not
  optional — vitest transpiles without type-checking, so a green suite can sit
  on a file that does not compile.
- You own `frontend/src/quick-connect.tsx`, `frontend/src/profiles.ts` and their
  tests. **Another worker is editing `frontend/src/suggest/` and
  `frontend/src/editor.ts` in a separate worktree.** If you both need
  `main.tsx`, keep your edit to the minimum and say so in your report.
- Report **numbers, not adjectives**. Heartbeat at every phase change.

## Baseline

`npm test` green: 100 files, 1773 tests, ~18s.

## The gap

Quick connect **already** connects without saving anything:
`SSHAliasQuickConnectProvider` (`quick-connect.tsx:143`) takes
`newTabByHost(host, user?, port?)` and opens a session straight from a
`~/.ssh/config` alias — no profile written. So the ad-hoc path exists.

What does not exist is typing a host that is in **neither** the saved profiles
**nor** `~/.ssh/config`.

The parser is already written. `parseQuickConnect` (`profiles.ts:120`) handles
`user@host:port`, the `ssh://` scheme and bracketed IPv6. Its **only** caller is
`connections.tsx:1304`, which uses it to prefill the _new profile form_. So
typing a connection string today means "define a connection", never "connect to
it" — the parser for this feature exists and points at the wrong door.

The owner asked for it in one line: _a quick connect without adding a
connection_.

## What to build

A free-form entry in the quick-connect picker: when the typed query parses as a
host, offer a **Connect** item that calls the same `newTabByHost` the alias
provider uses. Nothing is persisted. Reachable by keyboard alone — the picker is
a keyboard surface and a mouse-only affordance is not a feature here.

**Ranking is the part that can hurt.** A free-form entry must never outrank a
real match. If the query matches a saved profile or an alias, that entry wins;
the ad-hoc entry is the fallback for "I know this host and you do not". Getting
this backwards means a mistyped alias silently becomes an ad-hoc connection to a
host that merely shares its name — a wrong machine, reached confidently.

**A malformed string must say why.** `connections.tsx:1327` already does this
well: it detects that the input contained `@` or `:` yet parsed to an empty
host, and reports the accepted formats. Reuse that judgement rather than
connecting to whatever fell out of the parser.

## Use the kit

Read `frontend/src/ui/README.md` first. The picker is built from kit
components; add your entry with the same identity classes and the visual
distinction the file already uses for "not a user-saved connection"
(`quick-connect.tsx:53`). A surface may **place** a kit component and may never
**repaint** it.

## Test first

Red before green. Assert: a query matching nothing offers Connect and opening it
calls `newTabByHost` with the parsed host/user/port and creates **no** profile;
a query matching a saved profile ranks that above the ad-hoc entry; a query
matching an alias does the same; a malformed string reports rather than
connects; and the entry is reachable by keyboard.

Note honestly that jsdom computes no layout, so nothing here proves placement.

## When you are done

```bash
orca orchestration send --type worker_done --subject "<one-line status>" \
  --body "<what changed, test counts before/after, whether you touched main.tsx, anything you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
```

```bash
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<reading|red|green|verifying>" --json
```
