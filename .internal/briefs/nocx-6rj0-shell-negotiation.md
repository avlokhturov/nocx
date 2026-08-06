# Brief — nocx-6rj0: stop assuming the far shell is bash

Supervised worker. Read this whole file first.

## Ground rules

- **No commit, no push, no branch.** **Do not touch `bd`.**
- **No repo-wide gates.** **Do run** `go build ./...`, `go vet` and
  `golangci-lint run` scoped to the packages you touch. Run the shell tests as
  `nix shell nixpkgs#zsh nixpkgs#dash --command go test ./internal/shellintegration/... -count=1`
  — several drive real shells and **silently skip** without them, so a green run
  that skipped them tells you nothing.
- You own `internal/ssh/ssh_real.go`, `internal/ssh/ssh.go` (minimally) and
  `internal/shellintegration/launcher*.go` + `scripts*.go`. **Three workers are
  live: one in `internal/shellintegration/inband*.go` and `internal/transport`,
  one in `internal/tunnel` + `internal/ssh/ssh_tunnel.go`, one in
  `internal/app/app.go` + `frontend/`. Stay out of all of those files.** If you
  need a change in `app.go`, describe it in your report instead of making it.
- Numbers, not adjectives. Heartbeat each phase.

## The gap

`internal/ssh/ssh_real.go:553` passes `ShellBash` unconditionally. The comment at
`:538` says it is a temporary default, and it was landed that way on the record
(`nocx-r52q`) — so this is a deferred decision coming due, not somebody's slip.

The launcher implements three tiers. Two of them — zsh and the POSIX minimal tier
built and measured against real dash and busybox ash in `nocx-518d` — are
reachable from their own tests and from nowhere else. A zsh host gets the bash
launcher. A busybox host gets a bash command that cannot exec. Fail-open catches
both, so the session works, as a plain terminal, with the tier we built never
running. That is the `AGENTS.md` rule-2 shape again: written, tested, unreachable.

## The hard part, stated honestly

The far shell is genuinely unknown before connecting, and the obvious shortcuts
are barred. AD-6 forbids sniffing the byte stream. A probe over a second exec
channel is the port-discovery mechanism, it costs a round trip, and it is not
always available (MaxSessions, ForceCommand, restricted shells). `ssh -G` knows
about the _client's_ config and nothing about the remote login shell.

## The candidate that costs nothing, and its caveats

sshd hands a remote command to the user's **login shell**. So the shell that
executes our start command _is_ the shell we are trying to identify, and it will
tell us for free: `$BASH_VERSION` is set when bash runs it, `$ZSH_VERSION` when
zsh does, neither when dash/ash does. No probe, no round trip, no second channel.
The in-band worker built exactly this dispatcher for a different delivery path —
read `internal/shellintegration/inband.go` for the shape before writing your own.

**Verify it rather than believing me.** The caveats are real and you must measure
each against a real sshd:

- The dispatcher itself now runs under an unknown shell, so it must be strictly
  POSIX. A bashism in the dispatcher fails on precisely the hosts the minimal
  tier exists for.
- `ForceCommand` and restricted shells change what executes.
- `$SHELL` is not reliably the shell that is running; prefer what the running
  shell says about itself.
- The bash launcher already wraps itself in `/usr/bin/env -u BASH_ENV bash -c`
  because `bash --rcfile <(...)` is a bashism that dies under dash. Whatever you
  build must survive the same test — and note `/bin/bash` does not exist on this
  machine, which is how five tests of this epic silently skipped.

If measurement kills the idea, say so with the evidence and fall back to a
profile field plus an exec probe under the port-discovery consent model. A
reasoned "no" with numbers is a good outcome; an unmeasured "yes" is not.

## Where the user's choice lives

A profile field that pins the shell must **win** over detection — a user who says
"this host runs zsh" knows something we do not. Where the shell genuinely cannot
be determined, the tier chosen must be **stated in the product**, not only in a
log: `AGENTS.md` says a soft degrade the UI does not show is how a missing
feature survives a release. The refusal-reason vocabulary already reaches the
session; use it.

## Test first

Red before green, against the in-process sshd `internal/ssh` already runs in its
tests. Assert: a zsh host gets the zsh launcher; a host with neither bash nor zsh
gets the minimal tier; a pinned profile field beats detection; an undeterminable
shell produces a stated outcome rather than a silent bash guess; and the
dispatcher itself runs clean under dash and busybox ash.

For every "returns an error when…" there is a paired "and on an ordinary host it
succeeds" — that pairing is missing elsewhere in this repo and cost us a key
nobody could obtain.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, which detection you chose and the measurements that decided it, test counts before/after, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<phase>" --json
```
