# nocx-w7h.15 — The completion adapter: a second shell answers what only a shell knows

**Bead:** `nocx-w7h.15` (P1, raised by the owner 2026-08-04: "требуется удаленное дополнение").
Read it first — `bd show nocx-w7h.15`. Its design section is binding; this brief adds the
boundaries and the seams that now exist.

## What a user can do that they cannot today

On an SSH session, type a partial path, press Tab, and get **the remote host's**
files — not the backend machine's. Today `fsProvider` refuses outright
(`applicable: ctx.isLocal`, `frontend/src/suggest/providers.ts:296`) and the user
sees the generic "No matches", which is `nocx-w7h.17`.

And in the same mechanism: `git ch` + Tab offers `checkout` and `cherry-pick`,
because git's own completion function answered.

## The boundaries you are crossing — what they already decided

Do not re-decide any of these. Read them before you design.

- **AD-1** — control plane is JSON-RPC, data plane is raw binary. A completion request
  is a JSON-RPC method. Nothing about it goes near the byte stream.
- **AD-6** — the backend never sniffs the byte stream. You may not read the user's PTY
  to learn what the shell would complete. You run your own channel and ask.
- **AD-8 / "Interface-first + DI"** — the completion source is an interface, wired at the
  one composition root (`internal/app/app.go`). Local and SSH are two implementations.
  A **third** — the Tier-B remote helper of `nocx-if6` phase B (AD-2 names it a build
  target) — must be able to drop in without reshaping the seam. Shape it so.
- **ADR-0004 §2** — the user's shell receives the line **atomically at submit**, so its
  readline buffer is empty or stale. This is why "forward a raw Tab to the user's shell"
  was withdrawn in design §8.7. The adapter is a **second** shell. The user's line is
  never touched, and no keystroke is ever forwarded.
- **ADR-0006** — marker-only prompt; it is also why we can only partly see a nested
  environment. The helper's environment is **not** the user's interactive one:
  interactively-defined functions, unexported variables and aliases are not there.
  Candidates must carry their source so the UI can say where the answer came from.
  Do not pretend the two environments are the same.
- **ADR-0020** — the lane. A second execution channel that is not the user's terminal is
  an established primitive here, not something you are inventing.
- **ADR-0015** — the precedent for the whole shape: when an authority exists, *ask it*
  (`ssh -G`) rather than reimplement its rules. bash's completion machinery is that
  authority. There is no cheap oracle — checked 2026-08-02, `cd` has no completion
  spec at all and `rmdir`'s is `complete -F _comp_complete_longopt`, a function **name**
  that must be executed to learn anything.
- **ADR-0021** — the line you are completing can contain secrets. Never log it.

## The seams that already exist — use them, do not build parallels

- **`internal/ssh.DiscoveryConn`** (`internal/ssh/ssh_discovery.go`) — this is your
  transport and it is proven. It holds an **owned pooled lease**, runs a bounded command
  on a **second exec channel**, caps output, and returns typed errors for session-refused,
  exec-prohibited and connection-lost, with a `MaxSessions` test. Do **not** open a second
  pool or a second connection.
- **`internal/shellintegration/scripts/nocx.bash`** already computes `compgen -c` in the
  background and ships it as an OSC 636 snapshot. What you are building is that same
  thing made **request/response**.
- **`internal/transport/ws_fs_complete.go`** + `contracts/fs.complete.schema.json` +
  `frontend/src/suggest/providers.ts` `fsProvider` — the existing local path completion.
  Its DTO shape and its provider are the model to extend, not to duplicate.

## What the discovery ladder taught, and it transfers verbatim

`nocx-iz2t` learned these the hard way against real hosts:

1. **Frame the response.** A remote shell can print a banner, an MOTD, a `.bashrc` echo.
   Wrap the payload in a nonce delimiter and reject a polluted answer **whole** rather
   than parsing what looks plausible out of it.
2. **Cap rows and bytes**, both, and say when you truncated.
3. **Never assume a tool is present.** The remote shell may not be bash. Detect the
   family; if it is one you cannot drive, say so in the empty state — do not guess.
4. **A failure is a stated reason, not silence** (AGENTS.md: a soft degrade must be
   visible in the product, not only in a log).

## Requirements

1. **The interface.** A completion source behind a Go interface at one composition root.
   Local (existing filesystem answer) and SSH (the adapter) are implementations. A relay
   is a future third and the seam must not have to change for it.
2. **The remote path answer**, through the shell's own machinery — `compgen -f` /
   `compgen -d` against the session's cwd, which OSC 7 already gives you. `cd` to it per
   request; do not carry state between requests you cannot prove is still true.
3. **The completion-function answer** — `_completion_loader` then `compgen -F _git -- ch`.
   This is what makes the mechanism worth building; paths alone could have been faked.
4. **The `DIRECTORIES_ONLY` table** (`providers.ts:269`) is deleted **where the adapter
   answers**, because the shell now answers. If a fallback survives for shells with no
   adapter, it is named and justified in a comment — not left implicit.
5. **The wire.** New or changed JSON-RPC result shape ⇒ a JSON Schema in `contracts/`
   **in the same commit**, `additionalProperties: false` **and** an explicit `required`,
   the generated TS committed (`npm run contracts:check`), plus both conformance tests —
   including `…_OverTheWireConformsToContract`, the real result off the real socket.
6. **Latency and cancellation.** Completion sits on the keystroke path. State a budget,
   honour the provider's existing `AbortSignal` (`signal.aborted` is already threaded
   through `suggest`), and make an in-flight request that the user typed past a no-op —
   never a stale dropdown.
7. **Failure paths, per AGENTS.md rule 3.** For every external call there is a test where
   it fails: connection lost mid-request, exec prohibited by the server, the remote shell
   family unsupported, the answer polluted by a banner, the output cap hit, the request
   cancelled. And the paired positive: **on an ordinary Linux host with bash it succeeds.**

## Acceptance — as assertions, not prose

- On an SSH session to a bash host, `ls /et` + Tab lists `/etc/` **from the remote host**,
  and an entry that exists only locally does **not** appear.
- On the same session, `git ch` + Tab offers `checkout` and `cherry-pick`.
- Each candidate reports its source, and the UI can distinguish an adapter answer from a
  local guess.
- With the SSH connection dropped mid-request, the dropdown shows a **stated** reason and
  the tab is still usable — never a spinner that never resolves.
- Against a host whose shell family the adapter cannot drive, the empty state says which
  and why.
- The local path completion still works exactly as before — one test proves it.
- `deadcode -filter 'nocx/internal/<pkg>' ./...` is empty for the new package **and** the
  end-to-end check above has actually watched a remote completion happen. Reachability is
  a floor, never the criterion (AGENTS.md testing rule 2).

## Out of scope — do not widen

- The remote empty-state message is `nocx-w7h.17`. Do not fix it here; make sure your
  failure reasons give it something true to say.
- The agent lane itself (ADR-0020) and the Tier-B relay (`nocx-if6` phase B). You shape
  the seam so the relay fits; you do not build it.
- Completion from history (`nocx-pu4.5`).
- Any change to the input-ownership state machine. It is marker-only and fail-open, and
  nothing here touches it.

## Working rules

TDD — the failing test first. Full local gate before you report: `gofumpt -l .`,
`golangci-lint run`, `go test -race ./...`, and in `frontend/`: `npx prettier --check .`,
`npx eslint .`, `npm run typecheck`, `npm test`. Commit messages carry the bead id.
Report a blocker as a question the same minute you hit it — a blocker that lives only in
a report evaporates between rounds.
