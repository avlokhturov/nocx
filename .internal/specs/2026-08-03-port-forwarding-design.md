# Port forwarding — local, remote and dynamic

**Date:** 2026-08-03
**Epic:** `nocx-wzc4`
**Binding:** AD-1, AD-6, AD-7, AD-8, ADR-0015
**Related:** `nocx-pu4` (shell integration, shipped), `nocx-9le.7` (reconnect),
`nocx-uahp` (environment identity), `internal/ssh/pool.go` (the connection pool)

---

## 1. What exists elsewhere, and what each gets wrong

**Tabby** — a modal form: bind address, port, arrow, target address, port,
description, and a Local/Remote/Dynamic control. It assumes you already know
what to forward. Fast if you do; useless if you do not.

**Orca / VS Code** — a PORTS panel with a **DETECTED** section and a *Forward*
button per row. This is the better half of the idea: you do not have to know the
port, you are shown it. Measured limitation, reproduced locally: `ss -tlnp` as
non-root named **3 of 9** listeners on this machine — `:53` (systemd-resolved)
and `:5355` (avahi) come back bare because they belong to another user. That is
exactly the owner's Orca screenshot, where 4 of 6 rows have no label. And one
row that *is* named reads `MainThread`: the kernel knows the **process**, which
is frequently useless.

**Warp** — nothing.

**The opening.** Orca detects ports but cannot say which of *your commands*
opened one. Tabby makes you type everything. Neither can label `MainThread` as
`npm run dev`. We hold a command ledger, so we can — with a claim we can
actually defend.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | **Discovery runs on a separate exec channel** on the existing SSH connection, never in the user's interactive shell. |
| D2 | **Discovery is a consented capability with explicit states**, not a property of SSH. It is best-effort auxiliary exec and it fails in named ways. |
| D3 | **Its own policy field**, `portDiscovery: auto \| ask \| off`, on the same profile cascade — **not** folded into `shellIntegration`. |
| D4 | **All three directions are in the domain model from day one**; implementation is ordered `-L` → `-R` → `-D`, and nothing is thrown away between them. |
| D5 | **Forwards can be stored on a connection profile** and established at connect time — forward in advance, without waiting to be asked. |
| D6 | **The ledger labels; it never claims causation.** "Port 3000 appeared while `npm run dev` was running", with confidence — never "opened by" on timing alone. |

## 3. Why a separate exec channel

`internal/ssh/pool.go` holds a ref-counted `ConnPool`, and `openShell` already
has a `*gossh.Client` (`ssh_real.go:561`), so a second `NewSession()` on the same
connection is nearly free. That buys four things:

- **AD-6 stops being an obstacle.** The result is ordinary backend-owned SSH
  metadata off its own channel, not the terminal byte stream parsed. No OSC
  payload, no nonce.
- **It works while a command is running** — the common case. `npm run dev` lives
  for hours, and during it the interactive shell is busy: our integration only
  executes at prompts, so it *cannot* run `ss` there at all.
- **Nothing is written to the user's tty**, their history, or their termios.
- **It does not depend on shell integration.** Discovery works where nocxify was
  refused — busybox, restricted shells, `RemoteCommand` hosts.

### 3.1 Where it does not work, and what must be said

The claim "works anywhere SSH works" is **false** and must not be made:

| condition | behaviour |
|---|---|
| `MaxSessions 1` | the shell takes the only channel; the detector is refused → `discovery unavailable: additional sessions refused`. **Never** "no ports". |
| `ForceCommand` | the exec may run the forced command instead, emitting arbitrary output, hanging, or causing side effects. Treated as undiscoverable, exactly as `nocx-pu4` treats it. |
| restricted shell | often permits a shell and refuses exec. Discovery capability and forwarding capability are **separate**: forwarding may still work. |
| `RemoteCommand` set | not a hard block, but a signal this is not an ordinary shell: automatic discovery defaults to off there and needs explicit consent. |
| jump host | transparent — the exec runs on the target — but latency and failure probability compound through every hop. |

**Framing, not parsing.** A forced command, a login banner or a policy wrapper
can prepend text. Valid output carries a fixed version sentinel; a sample
without the sentinel is rejected **whole**. We never scan arbitrary stdout for
plausible-looking port numbers.

## 4. Cadence

Per-prompt sampling is rejected. The dominant cost is not `ss` — it is the whole
transaction: channel open, exec request, shell/policy startup, at least one RTT,
runtime, transfer, and sshd/PAM/audit processing. On a 250 ms link that is a
several-hundred-millisecond round trip, and **each sample can write three sshd
audit records**. Turning every command a user runs into three audit entries is
unacceptable on a regulated host.

- One sample after the connection settles — **not** on the first prompt's
  critical path.
- A prompt is a **hint**, not a sample: debounce 750–1500 ms, and coalesce
  across tabs sharing one target connection.
- While a command runs: after a 2–3 s grace period, then no more often than
  10–15 s.
- Stop periodic sampling when the tab is hidden, unless an active forward needs
  a health check.
- Exactly one discovery in flight per authenticated target.
- Hard timeout, bounded stdout/stderr, maximum parsed rows.

**Backoff is typed, not uniform:**

| outcome | policy |
|---|---|
| success | normal cadence |
| tool absent | cache for the connection lifetime; never retry per prompt |
| extra session refused / exec prohibited / forced-command suspected | disable automatic discovery for this connection, expose **Retry** |
| timeout or transport pressure | 10 s → 30 s → 2 min → 10 min, reset on success |
| transport disconnected | cancel immediately; a result from the old connection never applies after reconnect |
| parser/version mismatch | mark `unsupported output`, cache the failed strategy, try the next probe once |

## 5. The probe ladder

Capability selection happens **once per connection**; afterwards only the
selected probe runs.

1. Linux `ss` — `LC_ALL=C ss -H -lntp`
2. Linux/BSD `netstat`, flags chosen from verified capability, never hopeful
3. BusyBox `netstat`, detected explicitly; accept that `-p` may be unavailable
4. macOS/BSD `lsof -nP -iTCP -sTCP:LISTEN`
5. `sockstat` where present
6. unavailable

Rules: never concatenate user-controlled values into these commands; separate
stdout from stderr; parse only the selected dialect; capture address family,
bind address, port and process evidence **independently**.

**Process evidence is `known | permission-denied | unsupported`** — never an
empty string, because "nobody owns it" and "I was not allowed to see" are
different facts.

**The overall result is one of** `available`, `available-limited`, `unavailable`,
`failed-transiently`, `permission-or-policy-refused`. A successful empty result
means "no listeners observed". **Every other state means "could not determine",
and must never render as "no ports".**

No `/proc` scraping in the first cut: it recreates `ss -p`, has the same
permission problem, and is an expensive remote census — the thing `nocx-pu4` §11
already rejected.

## 6. Consent

A timer that executes commands on somebody's server is categorically different
from passive forwarding, so it gets its own field rather than riding on
`shellIntegration`: a user may trust nocx to install prompt hooks and not to
inspect processes periodically, or the reverse.

`portDiscovery: auto | ask | off`, threaded through the same cascade as
`shellIntegration` (`internal/profile/profile.go`) — the dense, stored and sparse
types, the allowlist, both conversions, the layer merge, the provenance map, the
contract schema and the generated renderer type.

For automatic discovery to be acceptable: the purpose and probe family are
disclosed **before** consent; the setting states plainly that commands run
periodically and may appear in server audit logs; `ask` probes nothing until
accepted; the panel always shows discovery state and the last successful sample
time, with **Pause**, **Retry** and **Disable here**; diagnostics show strategy,
duration, exit classification and truncated stderr — not an uncontrolled dump of
remote output; no probe escalates privilege; **no detected port is ever
forwarded automatically**; and any bind broader than loopback requires an
explicit warning.

## 7. The tunnel model — one model, three strategies

Built for all three from the start (D4), because `-R` brings remote-listener
policy and `-D` brings SOCKS semantics, and a direction flag threaded into one
forwarding loop collapses under both. AD-8: a strategy behind an interface, not
a switch inside an implementation.

A tunnel record carries: **direction** (`local | remote | dynamic`); **requested
bind** and **actual bind** (they differ when port 0 is used); **destination**
(absent for dynamic); **scope/owner**; **lifecycle state**; **error reason**; and
**discovery provenance** — whether a human typed it, a detected row created it,
or a profile established it.

### 7.1 Local (`-L`) — ship first

`net.Listener` locally → `Accept` → `ssh.Client.Dial("tcp", host:port)` →
bidirectional copy.

- Default bind **`127.0.0.1`**, not `0.0.0.0`.
- `localhost` is ambiguous across systems: offer IPv4 loopback, IPv6 loopback,
  and all-interfaces as an explicit advanced choice with a warning.
- Local port `0` allocates an ephemeral port; **report the actual bound port**.
- Bind **before** reporting success: `EADDRINUSE`, invalid address and permission
  errors are synchronous, user-visible failures.
- **Do not pre-check whether the port is free** — that is a TOCTOU race. Attempt
  the listen.
- Privileged ports may fail; report the real error and never request elevation.
- Each accepted connection gets its own `direct-tcpip` channel; one failed stream
  must not kill the listener.
- A remote target refusing a connection affects that stream, not the forward.

### 7.2 Remote (`-R`) and dynamic (`-D`)

`-R` creates a **remote** listener via `Client.Listen`, is governed by the
server's `AllowTcpForwarding` / `PermitListen`, and exposes a bind on somebody
else's host — so it needs its own form and its own threat warning, never one
more segment in the local form. `-D` needs a local SOCKS server and a
destination policy. Both land after `-L`, into the model that already describes
them.

### 7.3 Lifetime and ownership

AD-7 gives a tab one interactive channel while the connection is pooled and
shared, so a forward must **not** hang off the interactive shell's goroutine or
borrow its pool reference.

- Every forward has its own backend id and its **own pooled-connection handle**.
- A detector goroutine must never retain a raw `*ssh.Client` after the
  tab-owned handle is released (`ssh_real.go:148`, `pool.go:299`).
- Cancellation: closing the auxiliary `ssh.Session` is what stops the remote
  exec — context cancellation alone does not make `Session.Run` context-aware.
  On tab death: cancel, close the session, discard late results, release the
  reference.
- First cut: forwards are **tab-scoped by policy, independently owned
  technically** — closing the creating tab tears down its forwards even though
  the shared connection survives, and closing one tab never kills another tab's
  forward.
- Connection loss moves a forward to `stopped: connection lost`. It never
  silently rebinds or claims continuity. Restoration waits for `nocx-9le.7` and
  must then verify the new SSH identity, that the local bind is still free, and
  that the user's persistence policy authorises it.

## 8. Forwards stored on the connection (D5)

The owner asked for it directly: *maybe add it to the connection itself, so you
can forward in advance*.

A profile carries a list of tunnel definitions — topology and policy only,
**never credentials**; authentication continues to come from the vault through
the connection layer. On connect, each is established, and each reports its own
outcome: a stored forward whose local port is now busy must fail **visibly and
individually**, not take the session down with it and not disappear quietly.

This is what makes the feature usable without discovery at all: the ports you
always forward to a given host are configured once, and they are simply there.
Discovery then covers the ports you did not expect.

Stored forwards inherit the same model as ad-hoc ones (§7); the only difference
is provenance and lifetime — they belong to the profile, and their scope is the
connection rather than the tab that happened to open it.

## 9. Surfaces

**A Ports panel** with three sections — **Detected**, **Forwarded**, and
**Stopped / errors** (shown only when non-empty). One panel owns the lifecycle:
manual creation, local bind, remote target, scope, age, activity, **Stop**,
**Copy**, **Open**. Discovery's own state — unavailable, limited, last sample,
Retry, Pause, Disable here — lives in this same surface, because a degrade that
is only in a log is the failure `AGENTS.md` names.

**A block-attached offer** when a listener appears during a known command
interval. The wording is the design, not a detail:

> Port 3000 appeared while `npm run dev` was running.

Not "opened by". Attribution by timing cannot survive: another tab or service
may open a listener in the same interval, a command can spawn a child and exit
before the listener settles, a dev server can close and reopen a port, process
evidence can vanish between samples on a permission change, and containers or
network namespaces can hide the real listener. The offer shows **why** nocx
thinks so — the ledger interval, the process evidence if any, the environment
identity and its confidence — and says "opened by" only when corroborated by
process ancestry.

**Do not reuse `BlockReceipt`.** It is the vault's capture UI, with save
semantics and its own accessibility text (`frontend/src/ui/block-receipt.ts`).
Reuse the *interaction pattern* — attached to the block, non-modal, never
expiring — and add a generic block-attached offer to the kit, or a typed variant.

**Detected → forwarded in one action.** A row shows the numeric remote
address/port, the best available label, the evidence quality, and a Forward
button. If the same numeric port is busy locally, default to an allocated
loopback port. On success the row immediately shows the usable local address,
with **Copy** and **Open**.

## 10. Acceptance, as assertions

1. A profile with `portDiscovery: auto` against an ordinary Linux host lists the
   remote's listening ports within one sample of the connection settling, with
   process labels where permissions allow and `permission-denied` where not —
   never a blank that reads as unowned.
2. A host with `MaxSessions 1` reports `discovery unavailable: additional
   sessions refused`, the interactive session stays fully usable, and **no**
   empty port list is rendered.
3. A host with no `ss`, no `netstat` and no `lsof` reports `unavailable` with the
   probes tried; the panel never shows "no ports".
4. `portDiscovery: off` produces **no auxiliary exec at all**, asserted on the
   SSH channel count, not on the UI.
5. `portDiscovery: ask` performs no probe until accepted, and the acceptance is
   recorded against the profile, not a hostname the remote reported.
6. Sampling cadence: after the settle sample, N prompts in quick succession
   produce **one** debounced sample, and two tabs on the same target coalesce to
   one.
7. A forward to a busy local port fails synchronously with `EADDRINUSE` and the
   panel shows it; the session and every other forward are unaffected.
8. Local port `0` binds an ephemeral port and the panel reports the **actual**
   port, not `0`.
9. Closing the tab that created a forward stops that forward and leaves another
   tab's forward on the same shared connection running.
10. Connection loss moves every forward to `stopped: connection lost`; none
    rebinds silently, and none claims to be running.
11. A stored profile forward whose local port is busy at connect time fails
    individually and visibly; the session still opens and the other stored
    forwards still establish.
12. A block offer for a port that appeared during a command says "appeared
    while", carries its confidence, and does **not** say "opened by" without
    process-ancestry corroboration.
13. An all-interfaces bind requires an explicit confirmation; loopback does not.
14. `-R` refused by the server's `AllowTcpForwarding` reports the server's
    refusal, not a generic failure.
15. Every JSON-RPC result and notification in this feature has a
    `contracts/` schema with `additionalProperties: false` and an explicit
    `required`, a generated renderer type, and an over-the-wire conformance test.

## 11. Explicitly out of scope

Automatic forwarding of anything detected. `/proc` process-tree crawling.
Container and Kubernetes namespace discovery. Port scanning instead of listener
introspection. Traffic counters and per-stream inspectors. Automatic public URL
generation. UPnP, firewall mutation, privilege escalation. Sharing forwards
across devices. Migrating a forward across a reconnect identity (that is
`nocx-9le.7`'s boundary to define first). Generated port descriptions.
A permanent remote helper for discovery alone.
