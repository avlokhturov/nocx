# Brief — nocx-q6xj: a POSIX `sh` integration script

You are a supervised worker. Read this whole file before touching anything.

## Ground rules

- **Do not commit, push, or create a branch.** The coordinator integrates.
- **Do not touch the issue tracker (`bd`).** Beads lives in a local Dolt database
  git does not carry — `bd show` finds nothing here. Everything you need is below,
  plus the tracked design spec named further down.
- **Do not run repo-wide gates** — no `go test ./...`, no repo-wide lint, no
  formatting sweep.
- **Do run** `go build ./...` and `go vet ./internal/shellintegration/...`. An
  error in a file you do not own: **report it, do not fix it**.
- You own **only** `internal/shellintegration/scripts/nocx.posix`, the embed line
  for it in `internal/shellintegration/scripts.go`, and your own new test file.
  **Another worker is editing `internal/shellintegration/install_remote.go` in a
  separate worktree — do not touch that file.**
- Report **numbers, not adjectives**.
- Heartbeat at every phase change (see the end).

## Baseline

`go test ./internal/shellintegration/...` passes on the commit this worktree was
cut from — measured, 4.2s.

## Context

Read `.internal/specs/2026-08-03-nocxify-design.md` §6 — it is tracked and in this
worktree. Short version: nocx's shell integration has three tiers. `enhanced` and
`blocks` need bash or zsh. This task builds the third, `minimal`, for hosts that
have neither — Alpine containers with busybox `ash`, Debian's `dash`, appliances.
`docker exec -it <c> sh` is the single most common nested case we have, and it is
where every competitor gives up: Warp's bootstrap uses `read -r -d ''`, a bashism,
so it cannot reach this tier at all.

## What is achievable, and it was measured before being specified

POSIX `sh` has no `PROMPT_COMMAND` and no preexec hook. But `PS1` is re-expanded
at **every** prompt, and `$?` is readable inside it. Verified:

```
docker run --rm -e 'PS1=<A>e=$? cwd=$PWD<B>' alpine:latest \
  sh -c 'printf "true\nfalse\ntrue\nexit\n" | sh -i'
```

prints `e=0`, `e=0`, `e=1`, `e=0` — busybox ash re-expands and `$?` is correct.
`dash` on `debian:stable-slim` behaves identically.

So the tier is: **OSC 133 A, B and D (carrying the real exit status) plus OSC 7,
emitted entirely from `PS1`.**

**C (command-started) is unreachable** through portable prompt hooks. Do not fake
it and do not approximate it. A block simply appears already finished, with no
running phase; that is a declared loss, stated in the spec, not a bug to paper
over.

## Two constraints that are easy to get wrong

1. **The `PS1` assignment must be single-quoted.** Double quotes expand `$?` once,
   at install time, and freeze that value into the prompt forever. The test must
   catch this — a naive implementation looks perfect on the first prompt.
2. **Capture the exit status before any command substitution.** Anything you shell
   out to in order to build the OSC 7 payload (hostname, URL-encoding) clobbers
   `$?`. The existing bash script has the same hazard and solves it explicitly —
   read `internal/shellintegration/scripts/nocx.bash`, the `__nocx_precmd`
   comment about capturing `$?` before any other command, including an assignment.

## Conventions to follow

`scripts/nocx.bash` and `scripts/nocx.zsh` are the house style: heavily
commented, every non-obvious decision explained in prose in the file, `__nocx_`
prefixes on every name because the script is sourced into the user's shell and
each name it defines is a name the user no longer has. Match that. In particular
do **not** declare anything `readonly` that a user might collide with — a
`readonly` collision cannot even be unset and breaks their shell for the session.

The marker payloads are the same as the bash script's; copy their exact byte
sequences from there rather than re-deriving them.

## Test first

Red before green. `scripts_exec_test.go` in this package already drives real
shells and asserts on emitted markers — extend that seam, do not build a new one.

Assert at minimum:

- under `dash`, a succeeding command yields A, B and D with status `0`;
- a failing command yields D with the **real** nonzero status;
- the status is still correct on the *third* prompt, not only the first (this is
  what catches the double-quote freeze);
- OSC 7 carries an absolute path and follows a `cd`;
- **no C marker is ever emitted** — asserting the absence is part of the contract,
  because a future change that "adds C" by faking it must fail this test.

If `dash` is not installed in this worktree, say so in your completion message
rather than skipping silently — a skipped test that reports success is the exact
failure mode `AGENTS.md` was written to prevent. `busybox` coverage may be out of
reach here; if so, state that as an explicit gap.

## When you are done

```bash
orca orchestration send --type worker_done --subject "<one-line status>" \
  --body "<what changed, test counts before/after, which shells you actually exercised, anything you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "internal/shellintegration/scripts/nocx.posix,internal/shellintegration/scripts.go,<test file>" --json
```

`--outcome failed` if you did not finish.

```bash
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<reading|red|green|verifying>" --json
```

`TASK_ID` and `DISPATCH_ID` are in the message that pointed you here.
