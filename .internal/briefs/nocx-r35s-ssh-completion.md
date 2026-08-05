# `ssh ` offers the wrong things, and the keys go to the wrong surface

Two bugs, one screen, one worker because they collide on the same story: **`nocx-r35s`**
(directories offered under `ssh`) and **`nocx-fijh`** (arrows and Tab do nothing there).

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) for the ground rules — no
commits, no repo-wide gates, no formatting passes, targeted verification only. Then read
`fd68cd2` (`git show fd68cd2`), the commit that already claimed "ssh offers hosts, not shell
history and file paths": what it built is right, what it missed is why the user is looking at
`Downloads/` under `ssh`.

## Bug 1 — a directory is not a destination (`nocx-r35s`)

`frontend/src/suggest/providers.ts`:

```ts
applicable: (ctx) => {
  if (!ctx.isLocal) return false
  if (ctx.position === 'argument') return true      // ← every command, including ssh
```

`DIRECTORIES_ONLY` can narrow `cd`, `pushd` and `rmdir` to directories, but there is no way
to say "this command takes no paths at all". So under `ssh` the filesystem provider runs
alongside the host provider and — per the screenshot — its rows sort **above** the host.

Fix it where the shape already is: a table, keyed by command word, that says a command takes
no filesystem candidates, sitting beside `DIRECTORIES_ONLY` and growing by addition. Use
`commandWord(ctx)`, which is the same derivation the dirs-only table and the host provider
already use — do not invent a second way to decide what command a token is under.

Assert what a user sees: in `ssh` argument position no candidate of kind `path` is produced
at all, and the rows that do appear are hosts and ssh history. A test that only checks
ranking would pass with the paths still there, one keystroke away.

## Bug 2 — two surfaces, one set of keys (`nocx-fijh`)

`frontend/src/editor.ts` consumes `ArrowDown`, `ArrowUp`, `Enter` and `Escape` whenever
`_hintItems.length > 0`, and the completion dropdown has its own navigation. In `ssh`
argument position both are live, so the hint list swallows the keys and the dropdown never
sees them — while the dropdown's own footer is on screen promising "↑ ↓ to navigate, tab to
cycle, → to accept".

**Do not fix this by reordering the checks.** Two surfaces claiming the same keys by accident
of evaluation order is the defect; whichever wins, the other still advertises keys it will
not receive. Decide which surface owns the keys when both could be open, state the rule in
the code, and make the footer a function of that rule rather than a constant. If the dropdown
now covers what the hint list was for under `ssh`, the honest fix may be that the hint list
does not open there at all — say so in your report if you conclude that, and what it would
cost.

The test drives it from the state the user is in: dropdown open under `ssh`, press the key,
assert the selection moved. Not "the handler was called".

## Files

`frontend/src/suggest/providers.ts`, `frontend/src/suggest/rank.ts` and their tests;
`frontend/src/editor.ts` and its tests. Nothing else — and nothing in `internal/`.

## Verify

`cd frontend && ./node_modules/.bin/tsc --noEmit` and vitest scoped to the suites you touch
(`src/suggest/*.test.ts`, `src/editor.test.ts`, and the completion suites if you touch them).
One `worker_done` stating which surface you gave the keys to and why.
