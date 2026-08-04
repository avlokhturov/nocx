# nocx-pu4.6 — nocxify rides the ssh command

**Bead:** `nocx-pu4.6` (P0). Read it first — `bd show nocx-pu4.6`. Its description carries the
evidence and the mechanism; this brief adds the boundaries and what must not be assumed.

The owner has asked for this four times in different words. It is the last thing standing
between a hand-typed `ssh` and command blocks.

## The one-line change in behaviour

Submitting `ssh user@host` sends `ssh -t user@host '<launcher>'` instead, where
`<launcher>` is what `internal/shellintegration.RemoteLauncher.StartCommand` already
produces for the managed path. The remote shell therefore starts integrated, and blocks
appear from its first prompt. Nothing is typed into the session afterwards, ever.

## Why the alternative is dead, so nobody revives it

In-band delivery after submit lands in whatever is reading stdin, and between the command
and the remote prompt that is `password:`, a 2FA challenge or a host-key confirmation. The
wrapper would be sent as the secret — to the remote, and into its auth log. No marker says
the far shell is ready, because the far shell is the one that emits none. `nocx-atyf.3`
tried the offer-then-type shape and was withdrawn; do not rebuild it.

## The boundaries

- **ADR-0015 / `nocx-difd`** — `ssh -G` is the config oracle and it reports a
  `RemoteCommand` the host's own config sets. Our rewrite is refused there. **Ask the
  oracle; do not guess.** `nocx-difd` exists because `ssh -G` was discarding exactly this
  field, so the plumbing is there.
- **Fail-open is the invariant** (ADR-0004 §1). Anything uncertain about the rewrite —
  an unparsed flag, a refused RemoteCommand, an `off` policy, a launcher that declines —
  means **send exactly what the user typed** and let the session be an ordinary terminal.
- **AD-6** — we parse a line we wrote ourselves, never the byte stream.
- **ADR-0004 §2** — `submit` already separates `plan.recordLine` from what reaches
  `sendDoc`. Use that seam: the history entry and the block header carry the user's line,
  the wire carries the expanded one. A user who reruns from history must rerun **their**
  command, which is then rewritten again — not the expansion.
- **AD-1 / contracts** — a new JSON-RPC result shape gets its schema in `contracts/` in
  the same commit, `additionalProperties: false` plus explicit `required`, generated TS
  committed, and both conformance tests including `…_OverTheWireConformsToContract`.

## The seams that exist

- `internal/shellintegration/launcher.go` — `RemoteLauncher.StartCommand(shell, opts)`.
- `internal/shellintegration/launcher_auto.go` — the one-line dispatcher that picks bash,
  zsh or POSIX **on the far side**, so we do not need to know the remote shell. This is
  what makes the rewrite possible for a host we have never seen.
- `frontend/src/ssh-transition.ts` — the parser that already decides "is this a simple
  interactive ssh login", with the tokenizer and the value-taking-flag table.
  `environment-commands.ts` delegates to it; keep one parser.
- `internal/transport/ws_shell.go` — where `shell.integrate` lives; the new method is its
  neighbour.

## Requirements

1. A JSON-RPC method returning the launcher command for the auto dispatcher, so the
   renderer can build the rewritten line. Behind the transport's existing seam, wired at
   the one composition root.
2. The rewrite itself, applied at submit for a simple interactive ssh login only.
3. `-t`, because a remote command otherwise gets no pty.
4. Quoting that survives a destination or flags containing shell metacharacters. A test
   with a nasty destination.
5. The `ssh -G` check for a host-configured `RemoteCommand`, with a clean fall back.
6. Policy `off` (`nocx-p0ug`) sends the original line. Decide and state in the commit what
   `ask` means now that the dangerous moment is gone — asking BEFORE sending is cheap and
   safe, unlike everything we tried before.

## Acceptance — as assertions

- `ssh user@host` in an integrated local tab yields command blocks on the REMOTE host from
  its first prompt, with no dialog, no chip and no second action.
- The history entry and the block header show the line the USER typed.
- **No write reaches the pty between submit and the remote's first marker** — one test
  asserts that directly. It is the safety property, so it gets its own test.
- A host whose config sets `RemoteCommand` gets the original line and an ordinary terminal.
- Policy `off` gets the original line.
- Rerunning from history rewrites again rather than replaying the expansion.
- One end-to-end check against a real bash on a real PTY — `cmd/e2e-sshd` exists and
  `e2e/shell-mode.spec.ts` uses it.

## Out of scope

Offering to SAVE the host as a connection (that is next and separate), the Tier B relay,
and anything about the ports panel or the tab title — those landed today.

## Working rules

TDD. Full gate before reporting: `gofumpt -l .`, `golangci-lint run`,
`nix shell nixpkgs#dash nixpkgs#zsh --command go test -race ./...` (dash/zsh are not on
this box's PATH), and in `frontend/`: prettier, eslint, typecheck, `npm test`. Report a
blocker via `orca orchestration ask` the same minute. Do not report as done anything with
no caller from `main()`.
