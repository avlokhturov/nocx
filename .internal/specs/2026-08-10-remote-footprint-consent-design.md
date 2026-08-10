# Consent before a remote footprint

- **Date:** 2026-08-10
- **Status:** design, approved by the owner; revised after adversarial review
- **Supersedes:** **N3** of [`2026-08-05-nocxify-delivery-modes-design.md`](2026-08-05-nocxify-delivery-modes-design.md)
  ("script mode wraps and installs automatically, without asking")
- **Reinstates, in a different shape:** D1/D2 of
  [`2026-08-03-nocxify-design.md`](2026-08-03-nocxify-design.md)
- **Brainstorming bead:** `nocx-i5yl`

## What is already decided, and by whom

Per AGENTS.md, the boundaries this design crosses and what they already say, before it
says what to build.

| Binding text                                           | What it already decided                                                                                                                                          | This design                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **N3** (2026-08-05 §3.5)                               | Script mode installs automatically, without asking; consent required only for the relay binary. Explicitly overrode ADR-0004 §2 for script delivery.             | **Reversed.** Requires an ADR.                                                                                                        |
| **N3's compensating control** (2026-08-05 §4.1)        | The product _shows_ the footprint with an uninstall action "even though consent was not asked" — a requirement, not hardening. Implemented as P10 / `nocx-bu6q`. | **Kept and repaired.** Stops being a compensation, becomes ordinary inventory.                                                        |
| **ADR-0004 §2** (2026-08-04 extension)                 | Consent once per destination; automatic integration only as an informed opt-in, "never as the default".                                                          | **Restored** for script delivery.                                                                                                     |
| **ADR-0024 decision 4**                                | _There is no in-band fallback tier._ No authoritative channel ⇒ conventional terminal: no blocks, no ledger. A weaker parallel lifecycle is forbidden by name.   | **Obeyed, not routed around.** This is what makes a decline expensive; the design states the cost instead of inventing a middle tier. |
| **ADR-0022**                                           | The ssh command line is the carrier; the backend composes the rewritten line for a child domain.                                                                 | **Load-bearing.** It is why the child path can be authorised at all (§3).                                                             |
| **ADR-0023**                                           | A jump route is its own host-key identity — the same spelling reached by a different route may be a different machine.                                           | **Extended to write authorization** (§2.3). This is a change from the installed-fact key.                                             |
| **ADR-0015**                                           | The oracle is `ssh -G <host>`, cached per resolved identity; typed `-F` files are not watched.                                                                   | **Reused,** with its cache caveat acknowledged (§6).                                                                                  |
| **AD-6**                                               | The backend never sniffs the byte stream.                                                                                                                        | **Why a conventional session gets no offer** (§3.3).                                                                                  |
| **AD-5**                                               | Tier A is integration with no remote install.                                                                                                                    | Already contradicted by N3; the ADR must amend it either way.                                                                         |
| `RelayConsent` (`internal/profile/profile.go:66`)      | Three-state, per destination, **never inherited** — "a group cannot express consent".                                                                            | **Shape reused** for the answer; deliberately not merged (§2.2).                                                                      |
| `PortDiscoveryMode` (`internal/profile/profile.go:95`) | Its own field, **not** folded into `desiredMode`, "because a user may trust prompt hooks and not periodic remote exec, or the reverse".                          | **Precedent followed.**                                                                                                               |
| `InstalledFact` (`internal/ssh/installed_fact.go:13`)  | Keyed by the resolved `ssh -G` identity, "never the hostname string".                                                                                            | **Deliberately diverged from** — see §2.3.                                                                                            |

## 1. Context

### 1.1 What is true on this branch

`shady2k/fix-omp-hide` made the persistent remote bundle **load-bearing**, and the
in-tree comments that say otherwise are stale.

The argv launcher no longer embeds the integration scripts; it _sources_ the published
generation (`internal/shellintegration/launch.go:93`):

```sh
. "${HOME}/.nocx/integration/${NOCX_GENERATION}/nocx.bash" 2>/dev/null
```

`launcher_bash.go:211` gives the reason, and `:215` the figures: embedding was **measured
at 171,678 bytes before that change**, against nocx's own conservative single-argv cap of
**122,880** (`maxFullLauncherLen = 120 * 1024`, `launcher.go:210` — _not_ the kernel's
`MAX_ARG_STRLEN` of 131,072). The same comment states the consequence: "a failed publish
leaves `NOCX_GENERATION` unset, the source line names no file, and the session is a
conventional terminal with a visible native prompt (ADR-0024 decision 4 — the
transient-integrated middle tier is **deleted**, not degraded to)".

> **Correct these in the first package.** `launcher_publish.go:10` and
> `install_remote.go:152` still promise "transient-integrated". They are what led one
> reading of this branch to conclude that declining an install was free.

Consequently: **on a remote host, no bundle means no integration.** The dependency on disk
is downstream of N3 — once installing was unconditional, sourcing the installed bundle was
the obvious way to fit under the cap.

### 1.2 Why this is being reversed anyway

The owner's principle: **if we leave a trace on someone's machine, we ask first.**

Building a no-disk delivery tier was considered and rejected by the owner: the argv cap is
hard and the scripts only grow, so a no-disk path is a reprieve rather than a solution.
Recorded here so it is not re-litigated.

### 1.3 What a decline actually costs

A conventional terminal on that destination: native input, a visible native prompt, one
continuous grid, **no command blocks and no command ledger**. The design does not soften
this and builds no middle tier to hide it.

## 2. The model

### 2.1 Two concepts, not one

A single three-state field cannot express both "what should nocx do on machines like this"
and "what did this user answer for this machine".

**`FootprintPolicy` — the inheritable policy.**

```go
type FootprintPolicy string

const (
    FootprintAuto FootprintPolicy = "auto" // install without asking
    FootprintAsk  FootprintPolicy = "ask"  // ask once per consent key
    FootprintOff  FootprintPolicy = "off"  // never install; never ask
)
```

- Cascade: profile → group → global → hardcoded default, the existing mechanism.
- **Hardcoded default is `ask`** — the principle expressed in code.
- Unrecognised stored values fall back at _resolution_, never at decode, exactly as
  `DesiredMode` and `PortDiscoveryMode` already do, so an explicit choice never becomes a
  silent no-op.
- **A connection with no profile (alias, ad-hoc, hand-typed) resolves global → default.**
  Normative, not incidental.

**The answer — backend-owned, not on the profile.** Absent / `granted` / `denied`,
persisted across restarts. Not on the profile because a hand-typed `ssh` has none, an
ad-hoc open has none, two profiles can resolve to one machine, and one profile's
resolution can change.

_Adding the policy to the cascade is not free._ It must be projected through
`SSHProfileOptions`, `StoredSSHProfileOptions`, `SparseSSHOptions`, the sparse/dense
conversions, the overlay, invalid-value fallback, source attribution, the patch paths, the
allowed-default keys, `EffectiveProfileDTO` and `contracts/profiles.effective` with its
generated TS. There is no structural obstacle; there is real surface.

### 2.2 Why not fold into an existing axis

- **Not a fourth `desiredMode` value.** `desiredMode` says _what nocx runs_; this says
  _whether anything stays on disk_. Folding them makes "integration, but no files"
  inexpressible — the exact reason `PortDiscoveryMode` is its own field.
- **Not merged with `RelayConsent`.** The relay is a deployed **binary**; this is a script
  bundle. Different risk, and the code already records that script mode never consults
  relay consent.

### 2.3 The consent key — and where it diverges from the installed fact

`IdentityKey` (`ssh_resolver.go:272`) is **user + hostname + port** (port 0 normalises to
22). The jump route is _not_ in it: two routes reaching the same spelling through different
bastions produce one key.

For an installed _fact_ that is defensible — it records what is on the machine.
For a write _authorization_ it is not, and ADR-0023 is the binding text: a jump route is
its own host-key identity, i.e. the same spelling reached differently may be a different
machine. Collapsing routes would let consent granted for one machine authorise writing to
another.

> **Decision (owner, 2026-08-10): routes are distinguished.** The consent key is the
> resolved identity **plus the resolved route** (the jump chain). It therefore
> deliberately differs from `InstalledFact`'s key. Reaching one real machine both directly
> and via a bastion costs one extra question; the alternative costs files on a machine
> nobody authorised.

Because the two stores now key differently, **neither may be derived from the other**, and
a fact must never be read as evidence of consent.

### 2.4 Asymmetric keying — the rule that closes the native gap

`DomainRequest` (`internal/lifecycle/protocol.go:209`) carries only `RequestID`, `Env`,
`Host`, `User`, `Port` — **never the user's original argv**. So once an empty grant lets
the user's own `ssh` run conventionally, nocx cannot know where OpenSSH actually went:
`-F`, `-o`, `-J` and config rules can move it.

The resolution is asymmetry:

> **A grant is stored only under a fully resolved consent key. A denial may be stored
> under a coarser key** (the `host/user/port` the request carried).

Safe in the right direction: a coarse denial forbids more than strictly necessary, whereas
a coarse grant would permit more than the user authorised.

This works because on the path that _does_ write, the backend controls the argv: for a
child domain, `buildSSHChildBootstrap` (`internal/app/childdomain.go:215`) composes the
rewritten line itself from `host/user/port` (ADR-0022). The identity resolved for that
composed argv is the identity that will actually be reached.

## 3. When the ask is raised

After the oracle resolves the destination, never from the shell parser's simplified fields:

1. Policy `off` → never install, never ask. Silent by request.
2. Policy `auto` → install.
3. `ask` + `granted` for this consent key → install.
4. `ask` + `denied` (at either key granularity) → conventional. No question.
5. `ask` + no answer → **ask, before any write-capable path is selected.**

### 3.1 Through the app editor — a preflight

The editor path needs an explicit boundary the current code does not have. Specified here
rather than left as an outcome:

- A **preflight RPC** carrying the oracle argv, answered with the resolved identity, the
  resolved route, and the consent disposition.
- Submission does not proceed until it settles. A dismissed dialog is **neither** granted
  nor denied: nothing is stored and nothing is submitted.
- On grant, the preflight mints a **short-lived, submission-bound authorization** naming
  the exact resolved key. The later `domain_request` must present it, or the backend
  re-resolves at grant time. Without this, policy or consent can change between check and
  use, and the later request — carrying only `host/user/port` — cannot prove it belongs to
  the decision that authorised it.

### 3.2 Nested `ssh` inside an already-remote parent — out of scope

`buildSSHChildBootstrap` refuses when the parent is not local ("ssh nested inside a remote
parent is not implemented") and the command runs conventionally. This design does not
change that, asks nothing there, and writes nothing there.

### 3.3 A conventional session gets no offer, by AD-6

If the parent session is not integrated there is no authenticated channel, no
`domain_request`, and the backend is byte-blind by AD-6. There is nothing to offer and
nothing to key it by. The offer for such destinations lives in the connection manager,
never inferred from the stream.

## 4. Wording

Both outcomes named, neither hidden, no argument:

> nocx can show commands as blocks on this host. That needs files in `~/.nocx`.
> **[Install]** **[Keep this host a plain terminal]**

## 5. Changing your mind, and what removal really removes

- The connection editor, beside relay consent. It must be visually unambiguous **which**
  it edits: the inherited _policy_ (may affect many destinations) or the _answer_ for this
  destination.
- The footprint screen: what is installed where, remove it, revoke the answer.
- The action reads **"remove managed integration files"**. `Publisher.Uninstall`
  deliberately leaves `~/.nocx`, `launch` and `tmp`; promising more would be a new untruth
  of the kind this design exists to remove.

## 6. Intervals, races and failures

Stated with both ends, per AGENTS.md rule 3.

- **The authorization interval.** An applicable grant (or `auto`) exists continuously from
  **before any write-capable delivery path is selected** until **publication completes or
  rolls back**. Selection, not the first byte: the full bootstrap launcher _contains_ the
  publishing prelude, so choosing it is already the authorised act.
- **Denied or `off` forbids activation, not just publication.** No `EnsureInstalledRemote`,
  **and** no launcher that sources or publishes a managed generation — including the
  compact installed path an existing fact would otherwise select. Pre-existing files are
  **not** deleted: the policy says "never install", not "delete". Reconnect is conventional
  until the user removes or re-enables it explicitly.
- **Reconciliation of pre-N3-reversal state.** Files and facts created under N3 survive the
  code change. On the first connection after it, `ask` is evaluated **before** the installed
  path is selected, so old state cannot bypass the new default. Greenfield: no schema
  migration, only this ordering rule.
- **Unwritable answer store ⇒ no remote write.** If the grant cannot be persisted, nothing
  is written: otherwise nocx leaves a trace it cannot show the authorization for.
- **Concurrency.** One pending decision per consent key (singleflight); concurrent callers
  join it. One waiter cancelling must not cancel the shared decision. If policy becomes
  `off` while a dialog is open, `off` wins and the dialog is withdrawn.
- **Revocation.** Prevents any not-yet-started publish immediately; an in-progress publish
  completes under its captured authorization or is cancelled with defined partial-write
  recovery. Live sessions stay live until disconnect.
- **Granted, publish failed.** The answer stays `granted`, and the **session says so** —
  "installation failed, conventional terminal". Today it is log-only on both halves: the
  SFTP publish is best-effort and logged (`ssh_real.go`, the ignored branches at :768–775),
  and `launchSourceLine` suppresses stderr on purpose (`launch.go:88`).
- **Over the argv cap.** `fullBootstrapLauncher` returning false against
  `maxFullLauncherLen` is mapped to `ReasonUnsupportedShell` (`launcher_bash.go:230,237`;
  `launcher_auto.go:82,86,90,97`) — untrue and unactionable. A distinct `argv-too-large`
  reason must exist **before** any UI claims installing would fix it.
- **`-F` cache caveat.** ADR-0015's resolver does not watch typed `-F` files, so a changed
  alternate config can keep returning a cached identity for the process lifetime. "A
  profile whose resolution changes gets a fresh ask" holds only within that limit, and the
  spec claims no more.

## 7. Scope

**In.** The policy field and its full cascade projection; the answer store keyed by
identity **+ route**; the preflight and its submission-bound authorization; asymmetric
denial keying; the connection-editor control; footprint revoke; the two visible-failure
fixes; correcting the stale transient-integrated comments; the ADR superseding N3.

**Out.**

- **Local install.** `internal/app/app.go:935` calls `EnsureInstalled`, which writes
  `~/.nocx` **and appends gate lines to the user's rc files**. Installing nocx on your own
  machine is the consent. Unchanged, by owner decision. _(Separate bead: local installation
  is invisible on the footprint screen, which lists remote facts only.)_
- **A no-disk delivery tier.** Rejected in §1.2.
- **Nested ssh inside a remote parent.** §3.2.
- **PR #69's blocker** (`nocx-292k`). Required for this design too, but not gated on it.

### 7.1 How the installed-fact repair must land first without being torn out

The repair records a fact from an **accepted passport**. A passport proves managed
integration _ran_; it does not prove policy _permitted_ it. So:

- The writer records **observation, never authorization**, and no consent decision may
  read a fact as evidence of permission.
- A `denied` destination may legitimately still carry an old fact — denial does not
  uninstall. But a **newly** accepted passport after a denial means a race or a bypass: it
  must not silently refresh the fact as though healthy; it is surfaced.
- The two stores key differently (§2.3) and are separate documents. Partial-write
  split-brain must be enumerated and reconciled, or one transactional owner chosen. Do not
  leave them merely "beside" each other.

## 8. Acceptance criteria, as assertions

1. **Authorization interval.** From before any write-capable delivery path is selected
   until publication completes or rolls back, an applicable grant or `auto` exists
   continuously. Every failure before that opening event leaves the remote filesystem
   untouched — asserted at each partial publisher failure, naming what exists on disk, in
   memory and in the store after each.
2. Declining leaves no `~/.nocx`, records a denial, and a second connection to the same
   destination **asks nothing and installs nothing**.
3. Two profiles resolving to one identity **and one route** share an answer; a changed
   route asks again; a changed resolution asks again _within_ the `-F` caching limit of §6.
4. **`off` on a group:** no connection begun while the effective policy is `off` writes or
   updates managed bytes on any member, and no member is asked. Files predating the policy
   remain until explicit uninstall, and no launcher activates them.
5. **Global `auto`** suppresses the ask only where no group or profile overrides it; a
   group or profile set to `ask` still asks.
6. An `ssh` submitted through the app editor raises the ask **before** submission; the
   grant that authorises the later write names **the same resolved key** the preflight
   decided on; a declined preflight cannot install; native input is never held behind a
   dialog and receives no offer (§3.3).
7. Granted + publish failed ⇒ the session **displays** the reason and the answer stays
   `granted`, asserted for each enumerated partial failure of the publisher.
8. A bootstrap refused for size reports a reason distinct from `unsupported-shell`.
9. Uninstall, revocation and inventory update are asserted **in both orders and at each
   partial failure**: which is durable, what the next connection does, and that clearing an
   answer while files remain cannot produce an ask that silently reuses them.
10. **No active artifact asserts N3 as current behaviour** — not code, comment, contract,
    generated type, UI label or test. Historical design documents keep their text and gain
    an explicit supersession note. (Known sites: `profile.go:38` and the hardcoded fallback
    near `:786`; `ssh.go:196`; `ssh_real.go:728`; `ws.go:1197`, `:1436`;
    `ws_shell_footprint.go:5`; `contracts/open.schema.json` and
    `contracts/shell.footprint.status.schema.json` with their generated TS;
    `frontend/src/capability.ts:38,66`; `profiles.ts:59`; `connections.tsx:207`;
    `desiredmode_test.go`, `resolver_test.go`, `ssh_launcher_test.go`,
    `ssh_lifecycle_test.go`, `ws_contract_test.go`, `connections.behavior.test.tsx`,
    `e2e/shell-mode.spec.ts`.)
11. **End to end, executable.** Against a disposable sshd under the e2e harness: connect to
    a fresh host; the dialog appears with both options; decline; assert a working terminal
    **and** that no `~/.nocx` exists on the far side; reconnect and assert no dialog and
    still no `~/.nocx`; grant via the named connection-editor control (the _answer_, not
    the inherited policy); reconnect; assert blocks are produced **and** `~/.nocx` exists.
    Each observable named as a selector or filesystem assertion, not as prose.

## 9. Testing notes

- Per AGENTS.md rule 4, these assertions belong in the beads; the implementer does not
  author them.
- Per rule 3, every external call gets a failure test — oracle resolution fails, publish
  fails mid-way, answer store unwritable, dialog dismissed rather than answered — and each
  "returns an error when…" is paired with "and on an ordinary machine it succeeds".
