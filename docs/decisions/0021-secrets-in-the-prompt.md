# ADR-0021 — Secrets in the prompt: mask what we keep, resolve what we can't

- **Status:** Proposed
- **Date:** 2026-08-02
- **Related:** [ADR-0008](0008-*.md) (output is never retained), ADR-0018
  (the encrypted store the masked rows land in), ADR-0011 §2 (a secret never
  comes back out of the backend), [ADR-0016](0016-a-secret-owns-its-name.md)
  (the vault owns the name `{{secret:NAME}}` resolves by), AD-6 (the backend
  never sniffs the byte stream).
- **Design:** this round's brief (secrets, round 1) and
  `.internal/plans/2026-07-30-vault-v1.md` (the reference grammar is private
  to `internal/vault`).

## Context

History records commands verbatim and completion offers them back, so a key
typed once lands in the encrypted store and is offered as a completion
candidate tomorrow. We shipped the recording and never shipped the guard.
This ADR settles what the guard is — and, just as important, what it is not.

The threat model is the owner's, stated verbatim: *"у нас нет задачи защищать
файл от процессов на этой же машине, лежит же история bash — и это никого не
парит… Наша цель — защитить файлы от чтения напрямую."* We are protecting the
durable files from direct reading, not the running process from the machine.

## Decision

**One durable text, always masked.** The user sees the real value on screen;
the durable history gets the masked one. There is ONE durable text and it is
masked — no redaction map, no two artifacts, no per-consumer filter, because
fewer places to forget is the whole design. The live viewport is untouched:
xterm renders what the program printed, and rewriting that stream would
violate AD-6. Masking happens at the wire, in exactly one place
(`internal/transport/ws_history_record.go`), the single writer of durable
rows. The row and both contracts carry the count and the kinds of what was
masked, so a block can say "3 secrets masked: openai, jwt" — an honest
redaction that says nothing is indistinguishable from there having been
nothing to redact.

**A line may reference a vault secret by name; the backend resolves it at
submit.** `{{secret:NAME}}` where NAME is the vault inventory name
(ADR-0016) — never a `sec:v1:...` reference, whose grammar is private to
`internal/vault`. The resolved value goes to the caller for the PTY write
and nowhere else: `history.record` receives the line with the reference
intact. A command carrying a reference moves to another machine and resolves
that machine's secret; a command carrying a pasted key is both dead and
dangerous. A sealed vault is a specific, actionable error (`-32001`,
`vault-sealed`), because the caller has to be able to tell "unseal and
retry" from "no such secret"; unresolved names are reported, never silently
left as literal text.

### What we can promise

- The secret does not reach our ledger: the durable command text is the
  masked one, and the mask facts are counts and kinds, never values. This
  round ships that half, end to end.
- The secret does not reach the shell's own history file. The line that
  reaches the shell is written by us, not retyped by the user, and the
  write seam that submits a resolved line to the PTY is the one place the
  shell-history boundary can be enforced (a leading space under
  `HISTCONTROL=ignorespace`, or bracketing the write with history
  suppression). That seam is the renderer's next round — nothing calls
  `vault.resolveLine` from the frontend yet — and this ADR pins the
  requirement it must satisfy: a resolved line submitted by the app must
  not be recorded by the interactive shell's own history the way a typed
  command is. What the shell does with a stream we deliberately hand it is
  ours to control at the write; what it does with a stream the user types
  is the user's own history policy, which this design never touches.
- The secret never enters a model context: nothing in this seam feeds a
  model, and ADR-0011 §2 already refuses to hand stored values back out of
  the backend except through the value's single crossing, which is the PTY
  write.

### What we cannot promise — and why it is not a defect in the design

**Substitution puts the value in the process's argv, and argv is readable by
`ps` for every process of that user, and is recorded by audit and by sudo.**
No architecture of ours removes that — it is how exec works. A reference
resolved into `argv[0]`'s argument vector is indistinguishable from a pasted
key from the moment the process starts. What the design does is bound the
value's lifetime to that one submission: it is not in the ledger, not in the
shell's history, not in any log. The exposure window is the command's own
execution, which is the window any pasted key already has.

## Consequences

**A masked command re-run from history looks real and cannot work.** The
durable text is the masked one, so re-running `curl -H "Authorization:
Bearer sk-p...7890" https://api.example.com` sends the mask, not the key.
That is correct: the mask must never be silently executed as if it were the
command. Enter on such a row must not run silently — the next round's
problem, named here so the block UI is built with it in mind.

**Searching for a fragment of a key finds nothing, correctly.** The masked
text contains no fragment of the key — a search for `sk-proj-abcdef` misses
the row. That is the feature, not a gap, and the search panel's coverage
line will have to say it: history is searchable, and key material is not in
it.

**An existing dev database that no longer opens is acceptable.** The schema
gains columns on a greenfield table; there are no migrations and we wrote
none. A dev database created before this change fails to open cleanly rather
than silently losing the new columns' meaning.
