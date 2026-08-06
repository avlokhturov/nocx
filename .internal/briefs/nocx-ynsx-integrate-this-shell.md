# Brief — nocx-ynsx: integrate the shell you entered by hand

Supervised worker. Read this whole file first. **This one can hurt a user's
session if you get it wrong, so the fences matter more than the feature.**

## Ground rules

- **No commit, no push, no branch.** **Do not touch `bd`.**
- **No repo-wide gates.** **Do run** `go build ./...`, `go vet`,
  `golangci-lint run` scoped to what you touch, and from `frontend/`:
  `./node_modules/.bin/tsc --noEmit`, `npx eslint src/`,
  `npx prettier --check src/`, `npm test -- --run` for what you touched.
- You own `internal/shellintegration/`, the frontend editor/input path, and
  whatever transport method you add. **Check with the coordinator before
  touching `internal/app/app.go` or `internal/transport/ws.go` — another worker
  may be there.**
- Numbers, not adjectives. Heartbeat each phase.

## Why this exists

The owner typed `ssh somehost` into a local nocx tab and nothing integrated.
Two paths were designed for that and neither exists: automatic rewriting of the
command before it runs went to epic `nocx-eepi` deliberately, and the **explicit
action** was never built. Deferring both left the feature with no manual route
either — the decomposition oversight this bead fixes.

## Read first

`.internal/specs/2026-08-03-nocxify-design.md` §4.4 and §5.3, and
`docs/decisions/0004-input-ownership-and-editor-abstraction.md`. Both are
tracked and in your worktree.

## What to build

A command-palette entry **Integrate this shell** plus a keybinding, which
bootstraps the shell currently at the prompt using the in-band fallback.

## The fences — these are the task

**1. Only inside a window we already own.** Permitted _only_ while nocx still
holds a **trusted A→B prompt from the current integrated shell**. Never after
markers have already disappeared. The reason is exact and worth internalising:
consent changes _authorisation_, not the _identity of the foreground process_.
A user clicking "integrate" does not make the thing reading stdin a shell —
if it is `vim`, we would type 10 KB into their file. `frontend/src/input-state.ts`
already models this (`PROMPT_READY`, `trusted`); use it, and refuse otherwise
with a stated reason rather than trying anyway.

**2. An input lease.** Before any byte goes out: pause user submission,
preserve the editor draft **byte-for-byte**, show that integration is running,
and let **Esc cancel**. No user keystroke and no bootstrap byte may interleave —
that is how a half-typed command becomes a half-executed one.

**3. `stty -g`, never `stty sane`.** Capture the exact prior termios and restore
_that_. `stty sane` is not restoration: it overwrites the user's legitimate
custom modes. Restoration must complete before any user startup file or
input-reading command runs, and **every** cancellation path must continue the
restore rather than abandon the stream — a user left typing blind, including
passwords, is the worst outcome available.

**4. Fail-open is absolute** (ADR-0004:60). Any failure leaves an ordinary
terminal with a **visible native prompt**. Never a suppressed prompt with no
input owner.

**5. It is never automatic and never remembered as automatic.** This action is
explicit every time. Do not add a "always do this here" checkbox — the marker-loss
offer (already built) is where per-environment memory lives, and it offers, it
does not act.

## What ADR-0004 forbids, so you do not rediscover it

That ADR already rejected: inferring "a process is reading stdin" from the byte
stream (:54, unknowable); `stty -echo` (:24, leaked termios breaks child
processes); and parsing away the echoed region (:27). **This task does none of
those** — it acts inside a window nocx already owns, on explicit request, using
raw mode with an exact save/restore. If you find yourself needing one of the
three, stop and escalate: it means the approach drifted.

## Test first

Red before green. Assert: the action is **unavailable** without a trusted
prompt; the draft survives byte-for-byte across a successful run and across an
Esc cancel; the exact termios is restored on success, on cancel, and on a
mid-flight failure; a failure leaves a visible native prompt; and no user byte
interleaves with the bootstrap.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, test counts, which fences you proved and which you only argued, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<phase>" --json
```
