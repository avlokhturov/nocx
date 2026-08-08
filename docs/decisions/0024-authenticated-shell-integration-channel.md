# ADR-0024 — The lifecycle leaves the byte stream

- **Status:** Accepted
- **Date:** 2026-08-08
- **Supersedes:** [ADR-0004](0004-input-ownership-and-editor-abstraction.md) §1
  (the marker rule), [ADR-0006](0006-marker-only-prompt-mode.md) §4 (`A → B`
  ownership), and the lifecycle half of `AD-5`.
- **Amends:** `AD-1` (what may cross the control plane), `AD-6` (who owns what).
- **Related:** `nocx-u7uh` (the epic that implements it), `nocx-mu8s` (the defect that
  found it), `AD-8`.

## Context

`nocx` reads the prompt/command lifecycle out of the byte stream as OSC 133
`A/B/C/D`, and hangs six things off it: input ownership, the live-region layout,
block boundaries, the command ledger, the environment stack, and the
`_shellIntegrated` latch that decides whether the block model applies at all.

OSC 133 is an **anonymous broadcast channel**. It is bytes on a tty, and every
process with that tty open can write it — a TUI, a `cat` of a hostile file, a
remote host's MOTD, a container's log, a filename, a stack trace. The stream
carries no writer identity and no Unix API attaches one: there is no "read these
pty bytes and tell me whose they are". We nevertheless treat every syntactically
valid marker as a statement by our own shell. `frontend/src/renderers/xterm.ts:87`
says so in as many words — "an untagged marker keeps driving block boundaries
exactly as before".

### How it surfaced

`omp` (opencode-go 17.1.2), an agent TUI that does not use the alternate buffer,
writes `ESC]133;B BEL` then `ESC]133;A BEL` during the repaint where it starts
working on a message. Captured under a bare pty with no shell in the picture, so
the attribution is certain. In nocx the live region collapses to `height: 0` and
the running program becomes invisible while still receiving keys. omp is not
misbehaving: it marks its own prompt, which is what the standard invites.

### What the neighbours do

- **Warp** emits `133;A`, `133;B` and `133;P;k=r` and **nothing else** — verified
  in the integration scripts embedded in its remote-server binaries. Its own
  comment calls them "standard prompt marker OSCs", used by
  `warp_update_prompt_vars` to route prompt bytes to the right grid. `133;C` and
  `133;D` do not occur anywhere. Its command lifecycle rides a private hook
  protocol instead — the hook vocabulary in the same binaries is `Preexec`,
  `CommandFinished`, `Bootstrapped`, `InputBuffer`, `ExitShell`, with fields
  `next_block_id`, `ps1`, `rprompt`. Both hostile sequences below were run in Warp
  and left its block intact.

  **This is protocol separation, not an out-of-band boundary.** If that private
  protocol is DCS, as its bootstrap suggests, it still travels through the
  terminal byte stream — DCS is an escape-sequence namespace, not a transport.
  What additional validation Warp applies is not established here, and nothing in
  this ADR should be read as a claim that Warp is vulnerable. What it does
  establish is that generic OSC 133 is nobody's lifecycle authority but ours.

- **VS Code** uses its own `OSC 633`, and its command-line report carries a nonce
  from `$VSCODE_NONCE`; an unverified command line is treated as untrusted. Also
  in-band, and also authenticated rather than merely renamed.
- **iTerm2** has had a remote-code-execution advisory (CVE-2026-41253) in which
  sequence handling acted without validating the origin of the sequences. Cited
  as the same design lesson, not as the same defect: the analogy is the missing
  origin check, and our case stands without it.

The common thread: a terminal that hangs behaviour off a stream sequence needs
some answer to "who said this". Nobody's answer is "whoever wrote the bytes",
which is currently ours. This ADR chooses the strongest available answer rather
than the most common one — nocx takes the lifecycle off the stream entirely
instead of authenticating it in place.

### What an attacker gets today

Ranked by severity, each with its path through this repo. None of it needs an
exploit chain; it needs a file with the right bytes in it.

1. **A trusted input surface, summoned by hostile output.** From `RUNNING_RAW`,
   `B, A, B` reaches `owned: true` — `B` leaves `RUNNING_RAW` for untrusted
   `PROMPT_READY`; the next `A` is _trusted_ purely because the state is no longer
   `RUNNING_RAW` (`input-state.ts:100`); the next `B` grants ownership
   (`input-state.ts:105`). `shouldShowEditor` is `owned && !nativeMode`
   (`native-mode.ts:7`), so nocx's own editor appears — while a foreign program is
   the foreground process reading stdin. What the user types there, believing they
   are at their shell, is submitted into the pty that program is reading. The
   editor resolves vault secrets into the line it submits, so this is a
   credential-disclosure path, not merely a spoofed prompt. **ADR-0006's
   marker-only mode amplifies it**: with `PS1` suppressed there is no native prompt
   left to compare against, so the forged surface is the only surface.
2. **Writes into the persistent history store.** A foreign `A` reaches
   `ledger.onMarker('A')` (`terminal-content.ts:1476`), which finalizes the running
   record (`command-ledger.ts:155-158`) and fires `onComplete`
   (`terminal-content.ts:915`) → `history.record` (`history-client.ts:54`). The
   record carries `trusted` (`history-client.ts:26`) — the same flag the sequence
   above launders — and the store's ack drives secret detection and its
   pending-capture offers. Arbitrary tty output can **prematurely finalize an
   app-opened entry and forge its status, timestamps and completion boundary**. It
   cannot choose the command text through this path — that comes from the
   app-owned editor. It chooses the verdict, and the verdict persists.
3. **A command that appears to have succeeded.** A foreign `D;0`
   (`terminal-content.ts:1487`) freezes the running block with an exit code the
   command never returned, and can pop a non-ssh environment
   (`terminal-content.ts:1494`). Everything the program prints afterwards is
   detached from the command that printed it.
4. **Hiding the foreground program.** The reported symptom: `setIdle()` →
   `.live-idle { height: 0 }` (`controller.ts:146`, `style.css:450`). The program
   still runs and still takes keys; the user cannot see what they are typing into.
5. **Forcing integration onto a session that has none.** Any marker latches
   `_shellIntegrated` permanently (`terminal-content.ts:1405`), which gates more
   than presentation — typed-`ssh` rewriting reads it at `terminal-content.ts:1020`.
   Hostile output selects which transformation path nocx applies to the user's
   next command.

### Why the obvious defences fail

- **Gate on the foreground process group** (`TIOCGPGRP`). It answers "who owns tty
  input now", never "who wrote these bytes". The counterexample needs no
  adversary: a program writes the marker, exits, the shell becomes foreground, and
  only then are the queued bytes parsed — the ioctl reports the shell and the
  foreign marker is accepted. A background writer gives the same false accept with
  no race at all. `tmux` collapses every pane to one outer pgid, `ssh` has no local
  pty to ask, and `set +m` puts shell and command in one group.
- **Tag OSC 133 and tolerate untagged markers.** The ambiguity then lives in the
  design permanently: each of the six consumers must remember to check, and the
  untagged path stays alive because the standard says it is valid.
- **Move the lifecycle to a private OSC.** This is worth doing for hygiene — a
  private grammar can reject everything unspecified, and foreign software stops
  colliding with us by accident. But it is a **namespace, not a boundary**. The
  bytes are still on the tty, so the token in them would be the only thing doing
  security work, and any capture of one valid frame replays forever. A private OSC
  as the root of trust would not eliminate the class; it would rename it.

## Decision

### 1. PTY output is render-only

No sequence parsed from the byte stream — standard OSC, private OSC, DCS, title,
terminal mode, or anything else — may grant DOM keyboard ownership, declare prompt
readiness, open or complete an execution attempt, assign an exit status, persist a
history record, enable integration-sensitive command rewriting, or authorize a
re-run.

OSC 133 `A`/`B` keep exactly one job: partitioning prompt bytes from output bytes
for rendering, and interop with other tools. `C` and `D` have no meaning to nocx.

OSC 7 (cwd) is unchanged, and "render-only" is not a promise that it is harmless:
it remains untrusted location metadata under its existing `AD-5` validation and UI
rules, feeding the location chip, duplicate-tab cwd and completion scope. It has no
input-ownership or lifecycle authority, which is all this ADR decides about it.

**One carve-out, and it is a rendezvous, not an authority.** A stream sequence may
_locate_ an already-authenticated lifecycle event in render order — see decision 7
— but may never create, authenticate, complete or assign status to an attempt on
its own. A fence with no authenticated event behind it does nothing at all. Written
down because the alternative reading forbids the only clean solution to render
ordering, and a future reviewer would be right to reject it under decision 1 as
otherwise phrased.

This is the whole decision. Everything below is how it is made true.

### 2. The lifecycle rides an authenticated channel that is not the tty

The contract is one sentence: **the shell reports its lifecycle over a transport
that is not the terminal, and no event is accepted without demonstrated authority
for the live integration domain.** The transport differs per environment behind one
interface; the contract does not.

Hostile _output_ cannot reach any of these transports — it writes to stdout, and
stdout is the tty. That is what removes the class rather than narrowing it.

**A domain is logical, and is never an alias for a transport.** An
`IntegrationDomain` is one authenticated shell or helper instance, carrying an
epoch and an optional parent; a `TerminalLane` is one input-routing lane with at
most one active domain; one transport may carry several domains. Activation,
suspension, restoration and closure are authenticated transitions, and an attempt
belongs to exactly one domain and cannot cross an activation boundary.

This is not built for the roadmap. nocx **already** has a nested environment stack
— ssh, sudo, su, docker, with passports — so a kernel that identified a domain
with its channel would not defer a future feature, it would silently regress a
current one the moment the passport machinery goes. What is deliberately **not**
built now is multi-lane discovery, routing and UI. The three properties that keep
the relay a third adapter rather than a protocol rewrite are cheap and are
required now: every envelope carries lane, domain and epoch; no API obtains them
from a singleton; the registry and the kernel are keyed by lane and domain even
while each adapter registers a single lane.

**Local shell.** A descriptor handed over at spawn through `exec.Cmd.ExtraFiles`;
the shell is already started by `exec.Command(shell, "-i")` + `pty.StartWithSize`
at `internal/pty/pty_local.go:160`. Descriptor discovery, direction, socket type
and shutdown ownership are open — see below.

**Over SSH, zero-install for supported shells, on a seam that already exists.**
`internal/ssh/ssh_tunnel.go:23` already defines `TunnelConn`: `Listen(addr)` asks
the remote sshd for a listening socket (`-R`), each accepted connection arrives as
a forwarded channel over the pooled connection `AD-5` already multiplexes, `Done()`
and `LostErr()` are a declared connection-loss contract, and its doc comment
already states that server refusal — `AllowTcpForwarding` off, or a bind outside
`PermitListen` — is a refusal rather than a dial failure. The remote hook connects
to that loopback port with bash's network redirection
(`exec {fd}<>/dev/tcp/127.0.0.1/<port>`, verified end to end here). The bind
address is the literal `127.0.0.1`, never `localhost`: the same file records that
a hostname bind is resolved by the server and cannot be verified locally.

Refusal is therefore detectable synchronously, before enhanced mode is offered.
It is **not** distinguishable — the ADR does not promise a diagnostic naming
`AllowTcpForwarding`, only a clean fall back to a conventional terminal.

"Supported shells" is the honest scope. bash with network redirection compiled in
is the first implementation; zsh needs `zmodload zsh/net/tcp`; POSIX `sh`, fish,
PowerShell and restricted shells need their own proven adapter or get nothing.
Failure to establish either the listener or the shell's connection leaves the
session conventional.

We request a loopback bind; the remote SSH server is trusted to honour it. That
bind is neither exclusive nor independently verifiable, which is one reason the
capability — not the address — is the authenticator.

**Nothing about the transport confers authority.** Access to it is not membership
in the domain: descriptor inheritance, discovery of the listening address, or the
mere creation of a connection must never let a descendant or another local user on
the remote host publish an event. The observable consequences are fixed here; the
wire representation is not:

- an inherited descriptor without domain authority produces no accepted event;
- an unauthenticated candidate connection can neither mutate nor preempt a live
  domain;
- authentication is established before any domain or sequence state is consulted
  or mutated;
- authority rotates with the epoch, and stale-epoch events are rejected;
- accepted events are replay-safe within their epoch.

Whether that is achieved by a bearer field per event, a MAC, non-inheritable
descriptors where a shell can guarantee them, or a helper that owns the key is an
implementation decision with its own bead. An ADR that fixed the wire format would
be wrong within a month.

The per-epoch capability is at least 256 random bits and is substituted into the
integration script text — `internal/shellintegration/inband.go:113` already
substitutes `@SID@` — never passed as an environment variable. Verified: a child
cannot read a non-exported shell variable, and a value that was never in the
environment is absent from `/proc/<pid>/environ`, which survives `unset`.

**Why the capability is mandatory rather than belt-and-braces, measured.** A child
of the shell inherits the descriptor: `bash -c 'exec {fd}>/tmp/x; …'` allocates fd
10 and the child still sees `10 -> /tmp/x` in `/proc/self/fd`. Bash's `{var}`
redirection is not close-on-exec. The transport stops everything that can only
write to the terminal; the capability stops a descendant that inherited the
transport.

`NOCX_SESSION_ID` stays exported and keeps its ADR-0006 §1 identity role. It is a
name, not a secret, and it authenticates nothing.

### 3. Establishment is a handshake, and "live" means past it

A listener existing is not a channel being live. The sequence is:

1. nocx establishes the transport (locally, hands over the descriptor; remotely,
   `TunnelConn.Listen`). Refusal ends here, in conventional mode.
2. The shell connects and sends an authenticated `HELLO` carrying epoch,
   capability, protocol version and shell kind.
3. nocx validates it and answers `ACCEPT`.
4. **Only after `ACCEPT`** may the shell suppress its prompt or emit lifecycle
   events.
5. Enhanced mode is entered only after the frontend has the accepted domain.
6. Timeout or any failure leaves the visible native prompt in place.

Without this, a shell can suppress its prompt while the accept loop, the validator
or the publication path is not ready — a shell with no usable prompt, which is the
failure ADR-0006 §5 exists to prevent.

The first authenticated connection claims the epoch. Later candidates cannot
preempt it. Failed authentication attempts are rate-limited, and connection count,
handshake size and handshake time are bounded, because on the remote side any
local user can open a socket to that port.

### 4. There is no in-band fallback tier

If no authoritative channel is established, the session is a conventional terminal:
native input, a visible native prompt, one continuous terminal grid and scrollback,
no command blocks, no command ledger.

**Render-derived "best effort", visual-only or disabled-action block-like grouping
is not a permitted fallback.** A block in nocx claims a command identity, a start
and an end, ownership of the output between them, a status and a duration. A grey
approximation withdraws the semantics while keeping the claim, and a user cannot
tell the two apart — which is the soft degrade this repo has already paid for once
(AGENTS.md, "A soft degrade must be visible in the product"). This does not forbid
ordinary terminal affordances that claim nothing about commands: search matches,
user-placed bookmarks, prompt decoration the shell itself draws.

We also do not ship a weaker private-OSC lifecycle beside the real one. It would
make "integrated" mean two different things, force every consumer to preserve the
distinction, and put the weaker path on exactly the unusual shells and remote hosts
with the least test coverage — while leaving the user unable to tell which
guarantee they have.

### 5. The lifecycle is attempt-based, and a start may come from either side

Editor submit synchronously creates an `ExecutionAttempt` — attempt id, app-owned
command text, domain, cwd and host at submit, start time — **before** the bytes
that could cause the shell's own start event are written to the pty. That ordering
already exists (`terminal-content.ts:1138`, `:1170`) and becomes a tested
invariant rather than an accident.

Both origins are legitimate, because an authenticated `Start` is exactly as
attributable as an authenticated `Complete`:

- an authenticated top-level `Start` arriving with an app attempt pending
  **attaches** to it and may not replace its id, command text, cwd, host or secret
  representation;
- an authenticated top-level `Start` arriving with nothing pending creates a
  shell-originated attempt — this is what gives native-mode commands structure;
- a `Start` arriving while an attempt already runs is a nested event or a protocol
  violation, and never silently opens a second top-level attempt.

Attachment is bounded: same domain, exactly one pending attempt, exactly one
attachment, before any prompt-ready or loss event. Where a shell's hooks cannot
distinguish a top-level command from a hook-internal one, the protocol carries an
explicit attempt id rather than relying on ordering.

The command-text rule is a privacy rule, not only an authority rule. For an
attached app attempt the shell's text is ignored outright: the wire line may carry
vault-resolved secrets while the app's text carries references, and the code
already keeps those distinct (`terminal-content.ts:988`). For a shell-originated
attempt, whether its text is persisted at all is a **separate decision** — an
authenticated origin does not make a line containing a literal password safe to
store.

The interval, with its closing events named:

> An attempt is open from submit or authenticated start until an authenticated
> same-domain completion. Channel loss, session exit, tab close, native-mode
> escape or a confirmed environment change may **abandon** it as `unknown`.
> Nothing may mark it successful, and nothing may assign it an exit code it did
> not report.

Absence of a completion is not a timeout — commands legitimately run for hours.
An attempt becomes `unknown` only when an authenticated snapshot says the shell is
back at a prompt with no recoverable completion, or the domain is lost, or the
session ends.

### 6. Ownership is a state you can only be given, and the buffer is a separate axis

`state + trusted + owned` is replaced by two orthogonal axes, so that presentation
can never restore authority:

```
Lifecycle: Native | PromptReady(domain) | Running(attempt) | Desynchronized(domain) | Lost
Buffer:    Normal | Alternate
```

A `PromptReady(domain)` value exists only after an authenticated, sequence-legal
prompt-ready event for a live domain. The editor owns keys because the lifecycle
axis says `PromptReady`, not because a second boolean does.

The lane's active domain is a stack, not a variable. Entering a nested
environment **suspends** the parent rather than destroying it, restoring it takes
an authenticated activation rather than a pop of ambient frontend state, and
events from a suspended or closed domain are rejected against the active lane.
That is the same model decision 2 fixes, seen from the state machine's side: the
lifecycle and the domain stack are one reducer, because splitting them would
force whichever landed first to be rewritten by the other.

Keeping the buffer on its own axis is deliberate. Stashing the previous state
inside an `AlternateBuffer` value would let a program enter the alternate buffer,
have integration revoked underneath it, and restore a dead domain's authority on
the way out. ADR-0004 conflated ownership and buffer presentation; this ADR does
not carry that forward.

The trust-laundering transition (`input-state.ts:100`, `trusted: m.state !==
'RUNNING_RAW'`) is deleted rather than patched: it exists only because trust was
guessed from the previous enum instead of established by the speaker.

### 7. Validation precedes publication; corruption degrades, it does not tear down

Every event is checked for protocol version, live epoch, domain, monotonic
sequence, legal transition, matching attempt and payload bounds before anything
downstream sees it. Invalid events mutate nothing.

**Authentication terminates in the backend.** Raw framing and domain
authentication happen in Go, next to the transports; only schema-checked
published facts cross the control plane; no capability and no raw frame ever
reaches the renderer, which validates legal application transitions and can
construct no authority of its own. The backend already owns `ExtraFiles`,
`TunnelConn`, the capabilities and the candidate connections, so shipping frames
or secrets to the renderer would widen the trusted computing base for nothing and
make a second frontend harder than it needs to be.

This does not weaken `AD-6`. The backend parsing **its own protocol on its own
socket** is not sniffing the byte stream, and `AD-1`'s 2026-08-02 amendment
already permits typed, schema-checked facts crossing the control plane. The
renderer keeps owning VT state; what it loses is the ability to mint authority
from it.

Replay, precisely: the validator rejects duplicate or decreasing sequence numbers
after authentication; sequence state mutates only after authentication; a reconnect
never resets the counter within an epoch; a new epoch means a new capability and a
reset counter.

**A gap or framing corruption does not revoke an otherwise authenticated epoch.**
A descendant that inherited the descriptor can interleave garbage, and a rule that
revoked on any gap would hand every ordinary program a one-write kill switch for
enhanced mode — reported as flaky, not as secure. Instead the domain enters
`Desynchronized`: editor ownership is revoked, input routes raw, the terminal stays
visible, ordinary lifecycle events are **quarantined**, and nocx requests an
authenticated state snapshot.

Bounded resynchronization may scan forward for the next independently
authenticated frame, which is safe because unauthenticated bytes can never be
published. But framing recovery is not state recovery, and this is the part that is
easy to get wrong: an accepted `Complete` whose `Start` was lost would attach to the
wrong thing, and an accepted `PromptReady` whose `Complete` was lost would hand the
editor the keyboard over an open attempt. **Only a snapshot answering nocx's own
refresh request restores authority** — reconciling the open attempt, resolving it
as `unknown` where no completion can be recovered, and never inventing success.

Scanning is bounded in bytes and time, frames are size-bounded, candidates are
rate-limited, and a recovery budget exhausted by repeated corruption revokes the
domain. Availability against a descendant that continuously writes to the
transport is not guaranteed and cannot be; integrity and safe recovery are.

**Render ordering** is the other reason a snapshot matters. The lifecycle channel
and the pty are independent streams, and SSH preserves order within a channel, not
across them: an authenticated completion can arrive before the command's last
output bytes. Freezing the block on the event alone would truncate real output.
So logical completion comes from the authenticated event, and the _visual_ freeze
waits for both that event and a matching unpredictable fence written to the pty
after the output — the carve-out in decision 1. A fence alone does nothing; an
event without a fence completes the attempt logically and defers the output
boundary. Its worst failure is cosmetic, and it must never become a second
authority.

### 8. Loss fails to native visibly; local state is atomic, remote effects are not

In one local transition, nocx revokes ownership, exposes the terminal, marks open
attempts `unknown`, and stops accepting events for the dead domain.

Restoring the user's visible prompt is a protocol action, not a state change, and
it can only be promised when the shell is still reachable. If the SSH connection is
gone, the honest result is a disconnected terminal and no restoration claim. If
only the lifecycle channel failed while the pty lives, restoration must be
acknowledged before the session is treated as a usable conventional terminal —
otherwise the user is left at a suppressed prompt with raw input, which is the
worst of both.

The two losses are different and must not share a code path: **SSH transport loss**
ends the domain, the capability, the listener and the attempt, and a new session
gets a new epoch. **Frontend/backend reconnect** must either resume the existing
domain or report ambiguity and revoke it.

### 9. Marker-only prompt requires a live authoritative channel

Prompt suppression is forbidden unless a domain is live in the sense of decision 3
— past `ACCEPT`, not merely connected. Suppressing the user's only native cue while
accepting readiness from an anonymous source is the phishing primitive in the
threat model above, and the two must never be separable.

A `Desynchronized` domain is not live. If corruption happens while the shell sits
at a suppressed prompt, waiting for "the next prompt" produces an invisible prompt
taking raw input; the refresh protocol therefore has an immediate response path,
and the shell restores a visible prompt until resynchronization succeeds.

### 10. The security boundary is stated, not implied

nocx defends against hostile bytes on the terminal from any source — files, logs,
MOTDs, remote output, container output, filenames, and ordinary TUIs that emit
prompt marks in good faith. That is the whole of the reported class.

nocx does **not** claim to defend against: a compromised shell or shell plugin; a
process that can inspect the shell's memory or the integration bootstrap as the
same user; a remote environment the user explicitly integrated, which is trusted to
report its own lifecycle honestly; or a compromised backend, renderer or validator.

Availability is bounded too, and stating it is part of being honest: a descendant
that can write to the lifecycle transport may force a safe transition to native
mode. It can never produce a validated event without the epoch's authenticator.

That second list is irreducible in kind. We can authenticate **who spoke**; we can
never prove a compromised speaker told the truth.

## What this deliberately leaves open

- **Whether the capability ever touches a named file.** The in-band installer
  writes its script to a remote `mktemp` file (`inband.go:113`), and `0600` plus
  unlink-after-source does **not** protect it from another process running as the
  same remote user — sourcing executes the whole file before the unlink. Preferred:
  the per-epoch capability never enters a filesystem object, and installed scripts
  stay capability-free. If the adapters make that impossible, decision 10 must name
  same-user bootstrap inspection as excluded rather than pretend the mode bits
  cover it.
- **The local descriptor's mechanics.** Discovery without exporting a secret,
  socket type (`SOCK_SEQPACKET` would preserve message boundaries where supported),
  direction, behaviour across a shell that `exec`s another shell, and shutdown
  ownership.
- **The wire format**, per decision 2: bearer field versus MAC, framing, and the
  descriptor number — POSIX `sh` guarantees only single-digit descriptors in
  redirections, and 3–9 collide with what user scripts use.
- **A forwarded unix socket** (`streamlocal-forward@openssh.com`) instead of a
  loopback TCP port, which would remove other-local-user reachability entirely.
  Whether the shells can write to one without a helper is the open half.
- **Persistence policy for shell-originated command text** (decision 5).
- **How common the no-transport environments really are.** POSIX `sh` remotes,
  `AllowTcpForwarding no`, `docker exec`. A research bead against real hosts, not
  a guess from an armchair: if it is common, Tier B moves up the roadmap.
- **Whether our scripts still emit OSC 133 `C`/`D`** for third-party interop now
  that we no longer consume them.

## Consequences

Deleted, not deprecated — the repo is greenfield and clean-only:

- the untagged-marker lifecycle path in `parseOsc133` (`xterm.ts:87`) and every
  consumer that reads `CommandMarker` kinds for authority;
- `_shellIntegrated` latching on any OSC 133 (`terminal-content.ts:1405`);
- the `trusted` boolean and its laundering rule (`input-state.ts:100`), and
  `trusted` as a field crossing to `history.record` (`history-client.ts:26`) —
  what persists becomes the attempt's domain-authenticated status;
- `ledger.onMarker` as an entry point for anonymous kinds (`command-ledger.ts:150`).

Added, in the backend: the channel, its handshake, its framing, capability
generation and substitution in `internal/shellintegration` and `internal/pty`; the
remote path built on the existing `TunnelConn` (`internal/ssh/ssh_tunnel.go:23`)
rather than a new one; the domain registry and the validator that terminates
authentication there. In the renderer: the published fact's type, the two-axis
state machine, and the projections that consume it.

The published fact gets a `contracts/` schema like any other result shape. The
channel's own framing does not: `contracts/README` scopes that directory to
JSON-RPC results, and the lifecycle channel is neither JSON-RPC nor necessarily
JSON. Widening it would be a deliberate change to that README, not a side effect
of this ADR.

This gives lifecycle authority **one publication boundary**. It does not shrink the
trusted computing base to one function: channel establishment, framing, the
capability and domain validator, the shell adapters and the attempt state machine
are all still trusted. What changes is that no ordinary renderer consumer can
manufacture authority out of terminal bytes.

## Revisit when

- The Tier-B remote helper is built (`docs/architecture.md:203`), at which point
  the environments with no transport today come back under this same contract,
  without it changing. Tier B is the lighter of the two remote binaries the
  architecture reserves: it augments a shell it does not own.
- **The relay lands** (`nocx-if6` phase B — a remote process that _holds the PTY_
  so a session survives a network drop). Then the remote case stops being a case at
  all: the relay spawns the shell, so it hands over an inherited descriptor exactly
  as the local path does, and the forwarded-port transport becomes unnecessary
  rather than supplemented. Worth knowing before anyone spends much on the
  forwarded-port path — it is the right answer today and the disposable one later.
- Reattachment after a relay reconnect is designed, which needs its own
  authenticated epoch rather than resumption of an old one.
- A supported shell cannot write to a non-tty transport from its prompt hooks —
  then the answer is a helper binary, not an in-band tier.
