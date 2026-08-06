# Brief — nocx-ynsx, resumed: the echo decision, and the rest of the task

Read `.internal/briefs/nocx-ynsx-integrate-this-shell.md` first — it is still the
contract. This file answers the question you escalated and lists what remains.
Your worktree and your work are intact; nothing was reverted.

## The decision: `stty raw -echo` is approved

You were right to stop, and right about the measurement. `stty raw` on GNU
coreutils leaves `ECHO` set; your `Lflag 0x8A38` reading and the echoed probe
byte settle it.

ADR-0004:24 rejects `stty -echo` for two named reasons, and the coordinator's
reading is that neither reaches your window:

- _"readline/zle do their own redisplay"_ — readline is not running. The shell is
  executing your wrapper as a foreground command; there is no line editor to
  fight.
- _"leaked termios state breaks child processes"_ — nothing leaks. `stty "$saved"`
  restores the exact prior state before any user code runs, and your pty tests
  already prove it bit-exact on success, on cancel and on fail-open.

What the ADR rejects is `-echo` **held across the user's session** as the
editor's echo mechanism. A transient delivery window with exact restore is a
different thing. **ADR-0004 now says so** — the scoping note is already committed
on your base branch, so re-read it rather than trusting this paragraph, and if
you think the note overreaches, say so before you build on it.

So: add `-echo`, make the three leak assertions green, and keep every restore
path exactly as you built it. Two things must not weaken:

- **The restore is still `stty "$saved"`, never `stty sane`.** With `-echo` in the
  window, a restore that misses is no longer "a bit odd" — it is a terminal the
  user cannot see themselves typing into. Add an assertion that `ECHO` is set
  again after the window on _every_ path you already test, including the ones
  where delivery fails.
- **Fail-open still wins.** If `stty` itself is missing or errors, the correct
  outcome is an unintegrated but usable shell, not a half-configured terminal.

Also fix the fall-through you identified — the top-level
`return 0 2>/dev/null || exit 0` after the dispatcher's cleanup. You found it;
leaving it for someone else to rediscover is how it becomes a bug report.

## What remains

Items 3–5 of your own handoff, and the all-clear you asked for is given:

3. **Transport RPC `shell.integrate`** — `internal/transport/ws_shell.go`, the
   dispatch case in `ws.go`, the `WSServer` field/option. **You may edit `ws.go`
   and `internal/app/app.go`.** Another worker is adding a different dispatch
   case in the same `switch` — keep your edit to the one case and the one field
   so the conflict, if it happens, is a two-line resolution.
4. **`contracts/shell.integrate.schema.json`**, the generated renderer type, and
   the over-the-wire conformance test. `additionalProperties: false` plus an
   explicit `required`, or it is theatre (`AGENTS.md` rule 5). The test that
   matters validates the result off the real socket, not a payload the test built.
5. **Frontend.** Gate on `PROMPT_READY && trusted && owned`. The input lease:
   editor hidden, draft preserved byte-for-byte, Esc cancels via the terminator.
   OSC 1337 ready-wait in the renderer. `integrateShell()` on TerminalContent.
   Palette item and keybinding in `main.tsx`.

**Another worker owns the ports panel in `frontend/src`.** Stay out of anything
named for ports or tunnels; if you both need `main.tsx`, keep your edit to the
palette registration and say so in your report.

## The one thing that would make this task a failure

A user presses the palette item while `vim` is open and 25 KB of shell script is
typed into their file. Consent changes authorisation, not the identity of the
foreground process. The gate is the trusted A→B prompt window nocx already owns —
not "the user asked for it".

## Gates

`go build ./...`, `go vet` and `golangci-lint run` scoped to what you touch; from
`frontend/`: `./node_modules/.bin/tsc --noEmit`, `npx eslint src/`,
`npx prettier --check src/`, `npm run contracts:check`, and `npm test -- --run`
for the files you touched. No commit, no push, no `bd`.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, test counts, the echo assertions, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
```

Heartbeat each phase. If you must escalate again, keep working on anything the
answer does not block while you wait — the coordinator was unreachable for ten
minutes last time and the whole task stalled behind one question.
