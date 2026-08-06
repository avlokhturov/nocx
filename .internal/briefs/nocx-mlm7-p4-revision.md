# P4 revision — two defects in the generated lines (`nocx-nl6q`)

Your predecessor's work in this worktree is **accepted apart from the two lines below**: the
typed plan, the refusal table, the quoting proof through a fake `ssh`, and the 53 tests all
stand. Do not redo the analysis and do not restructure `SshPlan` — P7 is already being
briefed against that shape. Read your own diff first (`git diff`), then fix exactly these two
things and extend the tests you already have.

## 1. `rm -f` after `ssh` destroys the command's exit status

You emit:

```
if [ -s P ]; then ssh -t … "$(cat P)"; rm -f P; else <typed>; fi
```

The branch's status is now `rm`'s, which is 0 almost always. The whole reason the local D
matters is that it carries `ssh`'s real code — 255 when the connection drops, 130 on
`Ctrl-C`, the remote shell's own code on `exit`. The spec's §7 assertion "the transition
record carries the local D's code" cannot hold against this line.

Put the removal where its status is discarded and the payload has already been read:

```
if [ -s P ]; then ssh -t … "$(cat P; rm -f P)"; else <typed>; fi
```

**Test it:** the fake `ssh` you already built exits with a chosen code; assert `$?` of the
whole wrapper equals it — 255, 130 and 0 — and assert the staged file is gone afterwards and
the identical rerun takes the else branch. Both properties at once, in one test, or they will
drift apart again.

## 2. The installed-host guard tests the wrong machine

You emit, faithfully following the spec as it was written:

```
if [ -x ~/.nocx/launch ]; then ssh -t <dest> '~/.nocx/launch <id>'; else <typed>; fi
```

That `[ -x ~/.nocx/launch ]` runs **locally**. It asks this machine whether _it_ has a
bundle, which is unrelated to the host being connected to — and on a developer's machine
`~/.nocx` exists as nocx's own local staging directory, so the answer is not even reliably
"no". The spec was wrong; it has been corrected and committed, so `git pull` is not needed
but **re-read §3.3** in `.internal/specs/2026-08-05-nocxify-delivery-modes-design.md` — the
guard now travels to the far side:

```
ssh -t <flags> <dest> 'if [ -x "$HOME/.nocx/launch" ]; then exec "$HOME/.nocx/launch" <environment-id>; else exec "${SHELL:-/bin/sh}" -l; fi'
```

No local guard, no local `else` branch: the far side is the only machine that can answer, and
its `else` covers the one case the `launch` script cannot cover — its own absence. Keep the
environment-id charset validation you already wrote. Watch the quoting: the remote command is
a single-quoted string containing double quotes, and `$HOME`/`$SHELL` must reach the remote
shell **unexpanded**. Prove that with the fake-`ssh` argv recorder, and prove the else branch
by pointing `$HOME` at a directory with no `.nocx`.

## Everything else is unchanged

Same worktree, same files (`frontend/src/ssh-transition.ts` and its test), same rules: no
commit, no push, no repo-wide gates, no formatting runs. Verify with
`cd frontend && ./node_modules/.bin/tsc --noEmit` and
`./node_modules/.bin/vitest run src/ssh-transition.test.ts`. Heartbeat per phase, one
`worker_done` stating the final wrapper text for both forms.
