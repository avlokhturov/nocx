# P9 — the environment boundary (`nocx-95kt`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first, then §5.3, §6 and §6.1
of
[`../specs/2026-08-05-nocxify-delivery-modes-design.md`](../specs/2026-08-05-nocxify-delivery-modes-design.md).
§6.1 is a table of eight sequences; **it is your test list**.

Everything below you has landed. Read before writing:

- `frontend/src/environment-passport.ts` — P2's tracker: `setExpectedEnvironmentId` before
  the line goes out, then `accepted | duplicate | unexpected | ignored`. Tagged markers carry
  `nocxEnv`; untagged ones do not.
- `frontend/src/command-ledger.ts` — P5's `enter(id)`, `completeTransition(exitCode)`,
  `transitionRecord`; `BlockManager.freezeEntered`.
- `frontend/src/ssh-transition.ts` — P4's `planSsh`, `buildBootstrapRewrite`,
  `buildInstalledRewrite(plan, environmentId, sessionId?)`.
- `internal/transport/ws_shell_launcher.go` and `contracts/shell.launcherCommand.schema.json`
  — P7's method: it takes the plan's `oracleArgv` and the session id, and returns the mode
  and the freshly minted `environmentId`. `shell.environmentObserved` is how an accepted
  passport (or its absence) reaches the backend.

## What you build

The wiring that makes all of it one behaviour, in `terminal-content.ts` — today it still
sends a bare destination and reacts to any OSC 133 D by popping the environment stack.

At submit: call P7's method with the typed plan, register the returned id with P2's tracker
**before** the bytes reach the pty, and build the bootstrap or the compact line according to
the mode it returned. On an accepted passport followed by a clean tagged A→B: enter the
environment, freeze the `ssh` block through `freezeEntered`, and report the observation to
the backend. On a local D: pop, and complete the dormant transition record with the real
code. Report the no-passport case too — that is what invalidates a stale installed fact.

## Files you own

`frontend/src/terminal-content.ts`, `frontend/src/input-state.ts`,
`frontend/src/environment-commands.ts` and their tests. Nothing in `internal/`, nothing in
`contracts/`, and not the four files listed above — if one of them is missing something you
need, say so in your report rather than editing it. P10 is working in `connections.tsx`, the
settings surface and the transport at the same time; do not touch those.

## What must be true — the eight rows of §6.1

Every one is a test:

- auth fails or `Ctrl-C` at `password:` — no passport, the block runs to the local D and
  shows the real exit status.
- a banner before `password:` — banner, host-key prompt and 2FA belong to the local block.
- the POSIX tier's orphan `D;0` before its first A — closes nothing, pops nothing.
- `ssh -t host tmux attach` — refused by the parser, and markers from an integrated tmux
  carry no expected id, so no transition.
- nested `ssh` at depth > 0 — raw; no rewrite is built inside an environment.
- `sudo -i` — a raw child shell, no transition.
- connection lost — the running remote command becomes `interrupted`/`unknown` with reason
  `transition-lost`; the transition record takes the local D's code.
- `Ctrl-D` with no running remote block — the local D still restores the parent environment
  and the editor.

Plus the two the block itself must satisfy: the `ssh` block carries the **local** host and
cwd (today `submit()` applies the environment entry before `ledger.open` and `beginBlock`,
so it is labelled with the destination), and entry counts only on
`expected passport → tagged A → B`.

## Verify

`cd frontend && ./node_modules/.bin/tsc --noEmit` and vitest scoped to your three test files.
Nothing repo-wide, no formatting runs.
