# P11 — the journey, end to end (`nocx-q3y9`)

Read [`nocx-mlm7-worker-rules.md`](nocx-mlm7-worker-rules.md) first, then §0 and §6 of
[`../specs/2026-08-05-nocxify-delivery-modes-design.md`](../specs/2026-08-05-nocxify-delivery-modes-design.md).

Ten packages have landed. **Your job is not to add behaviour — it is to prove the epic's
acceptance criterion actually happens**, against a real sshd, in one run a person could have
performed. Every previous package tested its own seam; nobody has yet watched the whole
thing work, and this repo's history says that is exactly where features turn out to be
missing.

## The criterion, which is your test

A hand-typed `ssh user@host` in an integrated local tab yields:

1. a **frozen local block** for the ssh command, labelled with the LOCAL cwd, containing the
   banner and the password prompt, which **ends when the remote session begins** — not when
   ssh exits;
2. **command blocks on the REMOTE host** from its first prompt, labelled with the remote
   context;
3. after `exit`, local blocks again and the editor back.

Then the variants that matter as much as the happy path:

4. a **second connection** to the same host sends the compact `~/.nocx/launch` line, not the
   argv-borne launcher — the installed fact from the first run is what makes that true;
5. **authentication failure** leaves an ordinary terminal: no passport, the block runs to the
   local D and shows the real exit status;
6. the remote host's rc files are **byte-identical** after all of it (`.bashrc`,
   `.bash_profile`, `.profile`, `.zshrc`, `${ZDOTDIR}/.zshrc`) — N4 is not negotiable and
   this is the only place it is checked against a real login;
7. `~/.nocx` on the host holds exactly one active generation whose manifest verifies.

## What exists to build on

- `cmd/e2e-sshd` — a real sshd this repo runs headless. `e2e/shell-mode.spec.ts` shows the
  pattern; `bd memories e2e` is worth reading before fighting the harness.
- `cmd/devharness` — the real backend headless, no wails, no GTK, no display.
- **The e2e suite gets a disposable `$HOME`.** On the default path `playwright.config.ts`
  applies it. On the headless path you start the backend yourself, so you must export
  `NOCX_E2E_HOME_DIR` and launch devharness with that `HOME` — `e2e/preflight.ts` prints the
  exact command when it stops you. Do not work around it by unsetting `NOCX_WS_PORT`: that
  boundary is what keeps a run off the developer's real settings, vault and rc files.

## Rules particular to this package

- **Do not change production code to make a test pass.** If the journey does not work, that
  is the finding — report it precisely (which step, what you saw, what you expected) and
  stop. A green e2e bought by editing the thing under test is worse than a red one.
- If a step is genuinely unobservable through the harness, say so and name what would make it
  observable, rather than asserting on a proxy.
- You own `e2e/` and any fixture glue you need there. Nothing else.

## Verify

Your own spec file, run against the real fixture. Report the run, its duration, and every
step you could not observe.
