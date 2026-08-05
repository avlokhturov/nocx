# P4 — a typed ssh plan (`nocx-nl6q`, and `nocx-c5az` / `nocx-sxdd`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first, then §3.2, §3.3 and the
delivery assertions of §7 in
[`../specs/2026-08-05-nocxify-delivery-modes-design.md`](../specs/2026-08-05-nocxify-delivery-modes-design.md).

## What you build

The part that reads what the user typed and decides, conservatively, whether nocx may ride
that command — and hands the answer on as a **typed plan** instead of a bare hostname.

Two shipped defects are yours, and they are the same defect twice: information thrown away
at the boundary.

- **`nocx-c5az`** — the renderer sends only `destination` onward, so `-p 2222`, `-F other`,
  `-o RemoteCommand=…`, `-l user` and `-J jump` are dropped before the `ssh -G` oracle ever
  sees them. The oracle then answers about a configuration that is not the one OpenSSH will
  use, and a rewrite gets allowed where it must be refused. Emit a typed plan carrying every
  accepted option; the backend half is P7's, so agree the shape by writing it down in your
  `worker_done`.
- **`nocx-sxdd`** — the staged launcher outlives its command, so recalling the rewritten
  line from the shell's own history with `Ctrl-R` bootstraps again. Fix it in the **wrapper**:
  the payload is consumed exactly once, and a later rerun of the identical line takes the
  `else` branch. `stage.go` stays a safety net for abandoned files and is **not** yours to
  edit.

## Files you own

`frontend/src/ssh-transition.ts` and its tests. Nothing else — `environment-commands.ts`
delegates here and must keep doing so; `terminal-content.ts` is P9's; `stage.go` and
`ws_shell_launcher.go` are P7's.

## What must be true when you are done

- every accepted option reaches the plan **exactly as typed**, including quoted values and
  `-oKey=value` written without a space.
- refusal — send the typed bytes unchanged — for: any shell operator (`|`, `>`, `>>`, `<`,
  `&&`, `;`, backgrounding), a remote command (a second positional), `-T`, `-N`, `-f`, `-W`,
  `-D`, `-L`/`-R` used to make a non-interactive session, `--`, an option we do not know, and
  any grammar the tokenizer cannot parse confidently. The current tokenizer admits it does
  not understand full shell grammar — make that admission a refusal rather than a guess.
- **`environmentDepth > 0` ⟹ no rewrite is built.** Inside a remote environment a local
  staged path would be read by a remote shell; the spec makes depth > 0 raw for this epic.
- a destination containing shell metacharacters survives quoting, proven by running the
  generated wrapper through a fake `ssh` that records its exact `argv`.
- the compact installed-host form of §3.3 is generated when asked for, guard included, and
  it too takes the `else` branch when the guard fails.
- the staged payload is consumed once: a second execution of the same line does not
  bootstrap.
- the plan is a value with a stated contract, not a string — P7 consumes it.

Write the tests as the table the spec's assertions describe; a case per refusal reason, and
for every "refuses when…" a paired "and this one is accepted".

## Verify

`cd frontend && ./node_modules/.bin/tsc --noEmit` and
`./node_modules/.bin/vitest run src/ssh-transition.test.ts`. Nothing repo-wide.
