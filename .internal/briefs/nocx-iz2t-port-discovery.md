# Brief — nocx-iz2t: find the remote's listening ports without touching the user's shell

Supervised worker. Read this whole file first.

## Ground rules

- **No commit, no push, no branch.** **Do not touch `bd`.**
- **No repo-wide gates.** **Do run** `go build ./...`, `go vet` and
  `golangci-lint run` scoped to what you touch.
- You own a new discovery package and, minimally, whatever `internal/ssh` must
  expose. **Other workers are live in `internal/app`, `internal/transport`,
  `internal/shellintegration` and `frontend/` — keep out.** `internal/tunnel`
  is finished and merged; read it, do not change it.
- Numbers, not adjectives. Heartbeat each phase.

## Read first

`.internal/specs/2026-08-03-port-forwarding-design.md` §3, §3.1, §4, §5 — the
whole design is there; this brief names only what is easy to get wrong.

## Why a second channel and not the shell

`internal/ssh/pool.go` is a ref-counted pool and `openShell` already has a
`*gossh.Client`, so a second `NewSession()` is nearly free. It buys three
things: **AD-6 compliance**, because the result is backend-owned SSH metadata
rather than the terminal byte stream parsed; **it works while a command is
running**, which is the common case and precisely when the interactive shell
cannot run anything, since our integration only executes at prompts; and it
touches neither tty nor history.

`nocx-6nh6` already added a lease seam (`TunnelConn`) that takes its **own**
pooled reference. Discovery needs the same discipline: never retain a raw
`*ssh.Client` past the handle you own, and closing the auxiliary
`ssh.Session` is what stops the remote exec — context cancellation alone does
not make `Session.Run` context-aware.

## The three things that must not be got wrong

**1. "Could not determine" is not "no ports".** The result is one of
`available`, `available-limited`, `unavailable`, `failed-transiently`,
`permission-or-policy-refused`. A successful empty result means "no listeners
observed"; **every other state must render as could-not-determine**. A
`MaxSessions 1` host, a host with no `ss`/`netstat`/`lsof`, and a `ForceCommand`
host each get their own named state — and the interactive session stays fully
usable in all three.

**2. Process evidence is three-valued**, `known | permission-denied |
unsupported`, never an empty string. Measured on this machine: `ss -tlnp` as
non-root named **3 of 9** listeners — `:53` and `:5355` belong to another user
and come back bare. "Nobody owns it" and "I was not allowed to see" are
different facts and the UI has to be able to tell them apart.

**3. Framing, not scavenging.** A forced command, a login banner or a policy
wrapper can prepend text to the exec's stdout. Valid output carries a fixed
version sentinel and a sample without it is rejected **whole**. Never scan
arbitrary stdout for plausible-looking port numbers.

## The probe ladder

Select **once per connection**, then run only the selected probe: `ss` →
`netstat` (flags from verified capability, never hopeful) → busybox `netstat`
(detected explicitly; `-p` may be unavailable) → `lsof -nP -iTCP -sTCP:LISTEN`
→ `sockstat` → unavailable. Never concatenate user-controlled values into these
commands. Separate stdout from stderr. Parse only the dialect you selected.

## Cadence and backoff

§4 has the numbers. The reason per-prompt sampling is rejected is **audit**, not
speed: each sample can write three sshd records, so it would turn every command
a user runs into three audit entries on a regulated host. Backoff is typed —
tool absent is cached for the connection lifetime and never retried per prompt;
sessions refused disables automatic discovery for that connection and exposes
Retry; a timeout backs off 10s → 30s → 2min → 10min.

## Scope

Discovery only. **Not** the panel, **not** the block offer, **not** the
`portDiscovery` profile field (that is its own task), **not** forwarding.
Expose the results and the state; do not render them.

## Test first

Red before green. Cover: a normal host; `MaxSessions 1`; no probe tool present;
output without the sentinel; a probe that times out; permission-denied process
evidence; and a cancel while a sample is in flight leaving no goroutine and no
retained client. `internal/ssh` runs an in-process SSH server in its tests — use
that seam.

## Reporting

```bash
orca orchestration send --type worker_done --subject "<status>" \
  --body "<changed, test counts, which states you exercised for real vs faked, what you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<phase>" --json
```
