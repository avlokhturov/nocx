# nocxify: three delivery modes, and where a command block ends

**Bead:** `nocx-n0qa` (brainstorming session). Supersedes parts of
[`2026-08-03-nocxify-design.md`](2026-08-03-nocxify-design.md) — see §8 for the exact
revisions. Owner decisions taken 2026-08-05; the reasoning that produced them is in §1.

## 0. What a user can do that they could not before

Type `ssh pi@192.168.0.93` by hand and get command blocks on the far host from its first
prompt, with the `ssh` command itself appearing as an ordinary local block that ends when
the remote session begins — and, from the second connection to that host onward, without a
200-character line on screen.

## 1. Why this document exists

`nocx-pu4.6` shipped the rewrite: a hand-typed simple interactive `ssh` is replaced at
submit with

```
if [ -s '/home/dev/.nocx/run/launcher-478956003' ]; then ssh -t pi@192.168.0.93 "$(cat '/home/dev/.nocx/run/launcher-478956003')"; else ssh pi@192.168.0.93; fi
```

The tty echoes what we send, so that line is on screen for the whole session — the `ssh`
block never finishes, because it ends at OSC 133 D and D arrives only when `ssh` exits.
The owner asked for Warp's presentation instead.

**What Warp actually does**, measured on this machine rather than assumed:
`~/.warp/remote-server/` on the remote host holds three ~215 MB binaries
(`oz-v0.2026.07.15.08.55.stable_01` … `oz-v0.2026.07.29.09.05.stable_02`), a
`server-<id>.sock`, a `server-<id>.pid`, its own `warp.sqlite` and `bundled_resources/`.
`~/.local/state/warp-terminal/oz/warp.log` shows `Handling Initialize`,
`Handling SessionBootstrapped: shell_type="bash"`, then 245 × `Handling RunCommand`. Warp
neither rewrites the command nor types into the tty: it deploys a server and drives the
remote through it. That is precisely the Tier-B remote helper `docs/architecture.md`
defers and `nocx-if6` phase B owns.

**Orca**, the other neighbour: `src/main/agent-hooks/remote-managed-hook-installers.ts`
installs its hooks over SFTP (`ssh2` `SFTPWrapper`) into the remote `$HOME`, once.

Both neighbours pay with a persistent remote footprint. nocx's visible line is the direct
price of D1 of the previous design — *no persistent remote footprint by default*. The
owner has now taken the opposite trade for the script tier, and that is decision N3.

## 2. Decisions

| # | Decision |
|---|---|
| **N1** | **Three delivery modes behind one seam** (AD-8), already half-declared as `Delivery = 'launcher' \| 'in-band' \| 'relay'` in `frontend/src/capability.ts:17`: **raw** (nothing added, plain terminal), **script** (the shell tiers we already ship — no compiled artifact), **relay** (Tier B, a deployed binary). Mode is a property of the destination, resolved per connection. |
| **N2** | **The rewritten line is visible, and that is the product.** No `stty -echo`, no renderer-side echo suppression, no `ssh` shell function that hides the expansion. ADR-0004 §24 and §27 stand unamended. What is shown is the line handed to the local shell; the launcher payload itself remains behind `$(cat …)` and behind `~/.nocx/launch` — the claim is "we do not hide the mechanism", not "every executed byte is on screen". |
| **N3** | **Script mode wraps automatically, without asking.** Consent is required only to deploy the relay binary. This replaces D1 and D2 of the 2026-08-03 design and requires amending AD-5 (§8). |
| **N4** | **No remote rc file is ever edited.** Script mode publishes a versioned bundle under `~/.nocx/` and activates it through the ssh command line. The rc-gate half of `internal/shellintegration/install_remote.go` is retired, not fixed. |
| **N5** | **An environment transition is proven by an identified readiness passport, never by an unnamed marker.** Entry counts only on `READY → clean A → B` with a fresh environment id. |
| **N6** | **One running block at a time.** No nesting, no suspended parents. The `ssh` block freezes as `entered`; its ledger record survives and takes the real exit code at the local D. |

## 3. Delivery modes

### 3.1 raw

Nothing is added to the command. The session is an ordinary terminal: no markers, no cwd,
no DOM editor, native input throughout. This is both a mode a user can select and the
**fail-open destination of every uncertainty** — policy `off`, a host whose config sets
`RemoteCommand`, a line the parser cannot classify, a failed `ssh -G`, a refused launcher,
a read-only remote `$HOME`. ADR-0004 §1.

### 3.2 script — first contact

The host has no bundle. The launcher travels in argv exactly as `nocx-pu4.6` ships it
today: staged in a local file because the canonical tty line is capped at 4096 bytes, read
by the local shell at execution time, handed to `ssh` through argv (bounded by ARG_MAX).
The line is long and visible (N2). Fail-open lives in the line itself: `[ -s … ]` false
runs exactly what the user typed.

Having started, the launcher **publishes the bundle** (§4) before exec'ing the integrated
shell, and reports the committed generation back through its readiness passport (§5).
Nothing is asked, nothing is written to any rc file.

### 3.3 script — installed

The bundle is committed on that host. The submitted line becomes

```
ssh -t pi@192.168.0.93 '~/.nocx/launch <environment-id>'
```

`~/.nocx/launch` is the activation carrier: it selects the tier for the shell it finds,
sources the bundle, emits the passport, and execs. It is fail-open by construction — an
absent, incompatible or unreadable bundle execs a native login shell and emits no
passport, which downgrades the session to raw and invalidates the local "installed" fact
so the next connection bootstraps again (§3.2).

**Why not a bare `ssh pi@host`.** The installed gate would have to be activated by
something the far shell can see. An rc gate conditional on `NOCX_SHELL_INTEGRATION` is
never activated, because OpenSSH does not carry that variable. An unconditional rc gate
integrates every terminal the user opens on that host, including ones nocx did not start,
and a marker-only prompt in a foreign terminal is an invisible prompt (ADR-0006 requires a
static opt-in). `SendEnv`/`SetEnv` depend on the server's `AcceptEnv` and are already
rejected as a carrier. `Match exec` + `RemoteCommand` in the local ssh config cannot tell
`ssh host` from `ssh host somecommand` and OpenSSH then refuses with *"Cannot execute
command-line and remote command"*. A byte-for-byte clean line therefore requires either
unconditional integration of the whole remote account or the relay — and the relay is
where it is bought (§3.4), not here.

### 3.4 relay

A deployed binary, Warp's shape. Explicit consent per host, out of scope here, owned by
`nocx-if6` phase B. Named in this document only so the seam it lands in is decided now
rather than forked into later.

## 4. Publishing the bundle

The remote state is a **versioned immutable generation**, never a mutated working file:

```
~/.nocx/
  integration/v10/{nocx.bash,nocx.zsh,nocx.posix}
  manifest.json          # protocol version, script version, per-file hash and mode
  launch                 # activation carrier, points at the active generation
```

- The directory is 0700 and every file 0600, set at creation, never left to umask.
- A generation is written to a unique temporary path and published by atomic rename. The
  manifest — the only thing that makes a generation active — is written **last**.
- Concurrency is guarded by an atomic `mkdir` lock with a stale-lock rule, and the version
  check is repeated **after** the lock is held. Two sessions racing to the same host
  converge to one committed generation.
- A committed generation newer than ours and protocol-compatible is **not** downgraded.
  Equality is not the comparison.
- `VERSION` matching alone never proves an installation: a generation is installed only
  when every file in its manifest exists with the recorded hash and mode.
- Every write boundary is a resumption point: an attempt interrupted anywhere converges on
  the next connection with no manual cleanup, and no half-written file is ever reachable
  from `launch`.
- Uninstall removes only manifest-owned, unmodified files; anything the user changed is
  reported as a conflict rather than replaced.
- A read-only `$HOME` publishes nothing and reports no installed fact; the session runs
  from argv as in §3.2, or raw.

The SFTP installer keeps its place for saved connections, where nocx owns the transport —
but it publishes **the same bundle and the same manifest contract**. One owner of the
behaviour, two carriers (AD-8).

## 5. The readiness passport and the environment boundary

Unnamed OSC 133 cannot carry this. `frontend/src/renderers/xterm.ts:86` delivers `A/B/C/D`
plus an exit code and nothing else, and `terminal-content.ts:900` pops the environment
stack on **any** D. Three concrete breakages follow: the POSIX tier's first emission is an
orphan `D;0` before its first A (`scripts/nocx.posix`), which a "first marker means we are
in" rule reads as `ssh` having finished; the first remote command's D is read as leaving
the ssh environment; and `ssh -t host tmux attach` into an already-integrated tmux emits
markers that announce an environment transition that never happened.

So the launcher emits a **passport** after the user's startup files have run and the hooks
are installed, immediately before the first prompt cycle, carrying at least: a fresh
environment id, the parent environment id, protocol and script version, capability tier,
and the installed generation. It is raw PTY data parsed by the renderer's VT parser, like
OSC 7 and OSC 133 — the backend stays byte-blind (AD-6), nothing is suppressed, and no
byte order is rearranged.

**Entry is counted only on `passport → clean A → B` with a fresh id.** Markers that carry
no id, or an id that is not the one we launched, change neither the environment nor
keyboard ownership. Every marker used for environment lifecycle carries its environment
id; a remote D closes a remote command, and only a **local** D pops the environment.

## 6. What the user sees

| block | label | contains |
|---|---|---|
| `ssh pi@192.168.0.93` | local (`~`) | the rewritten line's echo, host-key prompt, banner, `password:`, 2FA, MOTD — everything up to the passport. Freezes as `entered`, no exit code |
| next | `pi@raspberrypi:~` | the remote shell's first command cycle |
| … | `pi@raspberrypi:~` | ordinary remote blocks |
| `exit` | `pi@raspberrypi:~` | `Connection … closed.` — closed by the **local** D |

**Deliberate divergence from Warp:** the MOTD stays at the end of the `ssh` block rather
than opening the remote block. Warp puts it in its own block because its server owns the
remote session; the only way to draw that boundary here is OpenSSH's `LocalCommand`, which
needs either the user's `~/.ssh/config` or a flag on a line that will not exist once the
host is installed. The banner is genuinely output of the `ssh` command, so this is honest
rather than merely cheaper. Revisit when the relay lands.

Two presentation defects fixed with this: the `ssh` block currently carries the **remote**
host chip, because `submit()` applies the environment entry before `ledger.open` and
`beginBlock` (`frontend/src/terminal-content.ts`), and the block currently runs for the
whole session because it ends at D.

### 6.1 Edge cases, and what each must show

| sequence | required behaviour |
|---|---|
| auth fails / `Ctrl-C` at `password:` | no passport ever arrives; the block lives to the local D and gets the real exit status — the fail-open path, unchanged from today |
| banner printed before `password:` | banner, host-key prompt and 2FA all belong to the local `ssh` block |
| POSIX tier's orphan `D;0` before its first A | does not close the block and does not pop the environment |
| `ssh -t host tmux attach` | classified as a remote command, so never rewritten; markers arriving from an integrated tmux carry no id of ours and create no transition |
| nested `ssh` host2 → host3 | the rewrite must never place a **local** stager path in a line a remote shell will read. Depth > 1 is either explicitly supported through the remote bundle with a fresh id, or visibly degraded to raw |
| `sudo -i` on the remote | a new environment only on a passport with a new id; otherwise markerless fail-open |
| connection lost / timeout | the running remote command becomes `interrupted`/`unknown` with the reason, **not** a failure attributed to the command; the `ssh` ledger record takes the local D's code (typically 255) |
| `Ctrl-D` with no running remote block | the local D still restores the parent environment and the editor |

## 7. Assertions

Delivery and policy:

- uncertain plan ⟹ bytes sent == bytes typed.
- a rewritten submit ⟹ the ledger and the block header hold the typed line, and the local
  shell's own history holds the rewritten line. Two histories, both stated, neither faked.
- the renderer never suppresses, repaints or reorders the bootstrap echo.
- policy `off` ⟹ no rewrite and no remote write.
- command-line ssh options (`-p`, `-F`, `-o`, `-l`, `-J`) reach the `ssh -G` oracle and the
  installed-host identity, or the rewrite is refused.
- a failed `ssh -G` refuses the rewrite (today it proceeds — see §9).

Installation:

- a committed generation ⟹ every manifest file exists with its recorded hash and mode.
- an uncommitted generation ⟹ no activation path references it.
- the commit marker is written after all files and all activation paths.
- a matching `VERSION` alone never proves an installation.
- concurrent installs of the same version ⟹ exactly one committed generation.
- an installed newer compatible version is never downgraded.
- failure injected at each write boundary ⟹ the next attempt converges with no manual
  cleanup.
- read-only `$HOME` ⟹ the session is raw or argv-integrated and no installed fact is
  recorded.
- uninstall removes only manifest-owned unmodified files; a modified file is a reported
  conflict.
- no remote rc file is created or modified on any path.
- the SFTP carrier and the self-install carrier publish the same manifest contract.

Environment boundary:

- an environment is entered only on a correlated `passport → A → B`.
- an uncorrelated OSC 133 changes neither environment nor keyboard ownership.
- every marker used for environment lifecycle carries an environment id.
- a remote D closes a remote command and does not pop the environment; a local D pops the
  environment and never assigns its code to a remote command.
- no passport ⟹ the `ssh` block stays running until the local D.
- disconnect ⟹ the active remote command is `interrupted`/`unknown` and the `ssh` record
  carries the local D's code.
- the frozen `entered` block has no exit code, and its ledger record still receives one.

## 8. Documents this revises

These are binding texts, so they are amended deliberately rather than excepted:

- **AD-5 in `docs/architecture.md`** defines Tier A as integration with no remote install.
  Script mode now installs a bundle by default. AD-5 changes, or N3 does.
- **D1** of the 2026-08-03 design ("no persistent remote footprint by default") is
  replaced by N3. **D2** ("consent is a property of the connection") narrows to the relay;
  script mode does not ask.
- The same document's assertions **8** ("no bash footprint"), **13** (rc `exit`/`exec`/
  `return` semantics — which contradicts the launcher's own behaviour on a top-level
  `return`) and **15** ("no silent rewrite", which held vacuously and no longer does) are
  restated against N2/N4.
- **ADR-0006** is refined: ownership requires the passport plus a clean A→B, not the mere
  arrival of an OSC 133.
- **ADR-0008** gains the `entered` block state — frozen in the UI, still open in the ledger.
- **ADR-0004** is untouched, and N2 is the reason it can stay untouched.

## 9. Defects in shipped code, filed separately

Found while designing this; they are bugs in `nocx-pu4.6` as merged, not new work:

- the renderer sends only `destination` to `shell.launcherCommand`, dropping the typed
  `-p`, `-F`, `-o`, `-l` — so the `ssh -G` oracle answers about a different configuration
  than the one that will run.
- `internal/transport/ws_shell_launcher.go` refuses the rewrite only when `ssh -G`
  succeeds *and* reports a `RemoteCommand`; a **failed** oracle still rewrites, which
  inverts fail-open.
- `internal/shellintegration/stage.go` removes stale staged launchers only on the next
  `Stage`, so a rerun from native shell history re-triggers a bootstrap for as long as the
  file survives.

## 10. Out of scope

The relay binary (`nocx-if6` phase B) beyond naming its seam; Warp's separate MOTD block;
an `ssh` shell function; renderer-side echo suppression; and any change to how the local
shell is integrated at spawn.
