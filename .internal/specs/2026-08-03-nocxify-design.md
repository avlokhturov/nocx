# nocxify — shell integration on any host, at any depth

**Date:** 2026-08-03
**Bead:** `nocx-pu4` (epic) · brainstorming session `nocx-ht37`
**Related:** `nocx-5mn` (Tier A substrate), `nocx-uahp` (environment identity),
`nocx-ccn` (SFTP installer), `nocx-zys2`, `nocx-difd`
**Binding:** AD-1, AD-5, AD-6, AD-8, ADR-0004, ADR-0006, ADR-0008, ADR-0015
**Status:** design, revision 2 — rewritten after an adversarial review and after
extracting Warp's actual mechanism from its binary

---

## 1. The problem, and what is actually true today

nocx's enhanced command line — blocks, cwd, the DOM editor that owns input,
recall, the command-existence snapshot — exists only in a **local** shell. Open
an SSH tab and you get a plain terminal with a native prompt. Not by design; by
omission plus three defects.

**Defect 1 — the gate never loads.** `internal/ssh/ssh_real.go:507` wires the
SFTP installer: on every SSH connect it writes `~/.nocx/` on the remote host and
appends a gate line to the remote `~/.bashrc` / `~/.zshrc` (`scripts.go:48`).
Then `RemoteStartCommand()` starts
`NOCX_SHELL_INTEGRATION=1 exec "${SHELL:-/bin/sh}" -l` — a **login** shell, so
bash reads `~/.bash_profile`, not `~/.bashrc`. The gate lands in a file the
shell never sources.

**Defect 2 — enhanced input is off by construction.** Even with the gate loaded,
`RemoteStartCommand()` (`shellintegration.go:217`) sets neither
`NOCX_PROMPT_MODE=marker-only` nor `NOCX_SESSION_ID`.
`ActivationEnv(enhanced)` is called in exactly one place —
`internal/app/app.go:338`, the local PTY factory. An SSH session could at best
reach baseline markers, never the editor.

**Defect 3 — a failed gate strands the host permanently** (`nocx-zys2`).
`install_remote.go:52` writes `VERSION` *before* the gate loop at `:57`, and
`:31` early-returns on a version match. One failed append and every future
connection skips the install. This is the remote twin of the local fix at
`shellintegration.go:124`, which was never carried across.

**And we pay the worst price for nothing.** We silently mutate other people's
`~/.bashrc` on every server they connect to, without asking, and deliver none of
the benefit.

## 2. What Warp actually does

Not from the docs — extracted from `~/.warp/remote-server/…` on this machine
(2026-08-03). The docs describe the trigger as a regex on the typed command; the
binary shows something different and better, and the design below is calibrated
against the real thing.

**It does not edit rc files.** `~/.bashrc` and `~/.zshrc` on this host carry no
Warp reference, though the host has been warpified.

**`ssh` is intercepted by a shell function**, not a regex:

```zsh
function ssh() {
    if is_interactive_ssh_session "$@"; then
        warp_send_json_message "{\"hook\": \"PreInteractiveSSHSession\", ...}"
        if [ "$WARP_USE_SSH_WRAPPER" = "1" ]; then warp_ssh_helper "$@"
        else command ssh "$@"; fi
    else command ssh "$@"; fi
}
```

**`warp_ssh_helper` rewrites the invocation.** It mints a session id from
`/dev/urandom` locally and falls back to plain `ssh` if it cannot; runs `ssh -G`
and falls back when the destination sets a `RemoteCommand` (OpenSSH refuses both
— "Cannot execute command-line and remote command"); hex-encodes the bootstrap
"b/c it contains control characters" and decodes remotely via `xxd` or a
`printf` byte loop; emits a private `\e]9278;d;<hex>`; optionally reuses an
existing `ControlMaster` found via `ssh -G` + `ssh -O check`.

**Delivery is by shell startup arguments.** bash gets
`exec -a bash bash --rcfile <(echo '…')` with the in-binary comment *"we use the
--rcfile option so **no** startup files are evaluated"*; zsh gets a temp
directory, `ZDOTDIR` pointed at it, `unsetopt ZLE; unset RCS; unset GLOBAL_RCS`,
then `exec -l zsh`, with `WARP_SSH_RCFILES` holding the user's original
`ZDOTDIR` so the real rcfiles are still sourced.

**Where it does paste**, the form is
`  read -r -d '' WARP_BOOTSTRAP_VAR << 'EOM'` … `  eval "$WARP_BOOTSTRAP_VAR"`,
one leading space per line (betting on `HISTCONTROL=ignorespace`), inside a
`stty raw` window restored with `stty sane` before user rcfiles run "in case
they ask for user input".

**Its cost.** `~/.warp/remote-server` holds three 216 MB single-file
executables — 622 MB, old versions never pruned. That is the Tier-B server for
the file tree and AI features, not for markers.

**Where it is genuinely weak, and we are not:**

| | Warp | nocx |
|---|---|---|
| bootstrap grammar | `read -r -d ''` — a bashism | a POSIX `sh` tier is reachable (§6, verified) |
| `ssh` interception | defines `ssh()` **in your shell**, shadowing yours; aliases collide | the editor owns the text; nothing is defined in the user's shell |
| termios restore | `stty sane` — a blunt reset that discards custom modes | `stty -g` capture, exact restore (§4.4) |
| footprint for richer features | 622 MB of retained binaries | Tier A stays scriptless; Tier B remains deferred |

## 3. Decisions

| # | Decision |
|---|---|
| D1 | **No _persistent_ remote footprint by default.** Revised from "zero writes": zsh startup integration structurally requires a transient `ZDOTDIR` directory. Any transient artifact is mode 700/600, carries no secret, is removed before user startup code runs, and a cleanup failure is reported in the product with its exact path. Persistent install remains an explicit opt-in with a diff and an uninstall. Today's silent SFTP path leaves the default. |
| D2 | **Consent is a property of the connection.** `shellIntegration: auto \| ask \| off` on the profile, inheriting through group defaults and a global default. |
| D3 | **Delivery is by shell startup arguments, not by typing into a tty.** In-band injection is demoted to an explicit-action fallback, permitted only inside an interval nocx owns (§4.4). |
| D4 | **Three capability tiers**, including a POSIX-`sh` tier, each honestly named. |
| D5 | **Ownership is granted by acknowledgement, never inferred.** The DOM editor takes input only after a launcher readiness message *and* a clean A→B. |

**Withdrawn from revision 1**, because ADR-0004 already settled them:

- The *probe* — a short line typed into the far end to learn whether a shell is
  reading. ADR-0004:54: *"We do not try to infer 'a process is reading stdin'
  from the byte stream or termios — that is unknowable."*
- `stty -echo` around delivery. ADR-0004:24 rejects it: *"leaked termios state
  breaks child processes."*
- Renderer-side suppression of our own echo. ADR-0004:27 rejects it: *"breaks on
  wrapping, cursor motion, async output, shell plugins, and multiline commands."*

## 4. Delivery

One strategy interface (AD-8) replacing the single `RemoteStartCommand()`
string with a typed `RemoteLauncher` policy — the existing function is already
shell-dependent (it expands `$SHELL` and requests `-l`), so this is a shape the
seam wants anyway.

### 4.1 The launcher is shell-specific, never generic

A single "hex-decode, eval, detect `$SHELL`, exec" launcher is rejected. It is
parsed by whatever login shell sshd hands the command to — possibly restricted,
possibly not POSIX — and an eventual `exec zsh` loses the functions, traps,
non-exported variables and options the eval established. Decoding is transport
for building the shell-specific rc input; it is never the integration runtime.

**bash — no remote write.**

```sh
/bin/bash -c 'exec bash --rcfile <(printf %b "<escaped-init>") -i'
```

Invoked through an **explicit** `/bin/bash -c`, because process substitution is
parsed by the shell parsing the remote command. Verified: `bash --rcfile <(…)`
works under bash and dies with `Syntax error: "(" unexpected` under dash — and
sshd hands the remote command to the user's login shell. `printf` is the bash
builtin, not `/usr/bin/printf`; the payload carries no NUL; the whole launcher
is capped well below the remote `ARG_MAX`.

**zsh — a transient directory.** zsh has no `--rcfile`; `ZDOTDIR` names a
directory, and it cannot name a pipe. So: `umask 077`, `mkdir` a private dir,
write `.zshrc` into it, `export ZDOTDIR`, `exec -l zsh`. The generated `.zshrc`
captures the original `ZDOTDIR`, **removes its own file and directory before any
user code runs**, restores or unsets `ZDOTDIR`, sources the user's real startup
file from the original location, and only then installs nocx hooks. A trap
covers partial startup.

This is what forces D1's wording change. If a write of any duration is
unacceptable, zsh startup integration is unavailable and must degrade visibly —
not be smuggled past the decision.

**Not `Setenv`/`SendEnv`.** sshd rejects variables absent from `AcceptEnv`;
failure is the normal case, payload size is bounded, and the value lands in
`/proc/<pid>/environ`. Acceptable for a small optional hint whose reply is
checked; never a delivery mechanism.

### 4.2 Where the launcher must not be sent

| condition | behaviour |
|---|---|
| `RemoteCommand` set for the destination | send no launcher; run the configured behaviour; report `integration: none`, reason `remote-command`. Needs `nocx-difd` — our `ssh -G` oracle currently discards it (`ssh_resolver.go:51`, `:284`). |
| `ForceCommand` on the server | undiscoverable client-side. The absence of readiness must never enable ownership; the forced command receives no bootstrap remainder and stays usable. |
| restricted shell | never bypassed by invoking `/bin/bash` directly — that defeats administrator policy. Start the server-selected shell natively. |
| sh-only remote | start ordinary `sh`; offer the `minimal` tier only via a safe `sh` startup path. Never send bash/zsh syntax. |
| read-only `$HOME` | bash unaffected (we never touch `$HOME`); zsh needs writable secure temp storage. |
| no writable `/tmp` or `$TMPDIR` | bash works; zsh degrades to `blocks` or `none`. |
| Windows / OpenSSH server, unknown shell | native session; explicit action only. |

### 4.3 Startup equivalence is a declared contract, not a promise of identity

"Source the user's rcfile" is not enough. The launcher must reproduce what an
ordinary invocation would do. For **bash**: login vs non-login file ordering
(`/etc/profile` → first of `.bash_profile`/`.bash_login`/`.profile`, vs
`.bashrc`); not double-sourcing `.bashrc` when the profile path already did;
`/etc/bash.bashrc` only where the platform would; `BASH_ENV` not executing
attacker-or-accident code in the outer `bash -c`; `$0`, `shopt -q login_shell`
and `[[ $- == *i* ]]` matching the promised session type; `set -e/-u`, `shopt`,
DEBUG/RETURN/EXIT traps and both `PROMPT_COMMAND` forms preserved (the existing
script already wraps `PROMPT_COMMAND` and DEBUG, `nocx.bash:129`); history
settings recorded without being changed.

For **zsh**, additionally: the original *unset-versus-set* state of `ZDOTDIR`;
the full `/etc/zshenv` → `.zshenv` → `/etc/zprofile` → `.zprofile` →
`/etc/zshrc` → `.zshrc` → `/etc/zlogin` → `.zlogin` ordering for the selected
mode; `RCS`/`GLOBAL_RCS` at each phase — disabling them to avoid recursion can
silently skip administrator policy; `INTERACTIVE_COMMENTS`, `ZLE`, prompt
substitution and history options; `precmd_functions`, `preexec_functions`,
`zshexit_functions` and ZLE widget order; all four of `PROMPT`/`PS1`/`RPROMPT`/
`RPS1` (`nocx.zsh:72`); `$0`, `LOGIN_SHELL`, `SHLVL`.

**User startup wins.** If the user's rcfile `exec`s, `exit`s or returns early,
nocx does not start a replacement shell and does not inject afterwards.
Integration simply stays unowned.

Prompt ordering is fixed by ADR-0006:66 — nocx installs its overlay **after**
prompt initialisation, last.

### 4.4 In-band injection, demoted

Still needed for the shell you are already inside. Permitted only on an explicit
action, and only while nocx still holds a **trusted A→B prompt from the current
integrated shell** — never after markers have already disappeared, because
consent changes authorisation, not the identity of the foreground process.

Inside that window: an input lease (user submission paused, the editor draft
preserved byte-for-byte, Esc cancels), `saved=$(stty -g)` captured and restored
exactly — never `stty sane`, which discards the user's legitimate custom modes —
and raw mode used for the delivery, which also removes the `MAX_CANON` line
limit. Restoration completes before any user startup file or input-reading
command runs, and every cancellation path continues restoration rather than
abandoning the stream.

## 5. Trigger and consent

### 5.1 Connections nocx opens

A new field on the existing cascade: Settings global default →
`Group.Defaults` (`profile.go:263`) → `Profile.Options.shellIntegration`
(`:94`), values `auto | ask | off`. The field must be threaded through the
dense, stored and sparse option types, the allowlist, the conversion functions,
the layer merge, the provenance map, the contract schema and the generated
frontend types — the cascade's containers exist; support for a new field does
not come free.

`auto` integrates at startup, silently, in the interval nocx owns.

### 5.2 Shells entered from inside a session

Marker loss raises **an offer**, never an action. It is an ambiguous signal — a
TUI, `reset`, an alternate screen, a long-running command, `read`, a password
prompt, an unset `PROMPT_COMMAND`, a crashed integration and `exec` all produce
it — so it may light up an affordance and must never authorise typing. The offer
uses the pattern already proven on secrets (`nocx-xkve.8`, kit `BlockReceipt`):
attached to the block, non-modal, never expiring, never superseded. The answer
is stored against `environmentId` (`nocx-uahp`), not a host string.

### 5.3 Rewriting a command before it runs

We hold the exact text before submit (`terminal-content.ts:421`), and ADR-0008:45
already treats that text as authoritative — AD-6 constrains the *backend* from
interpreting the byte stream and does not bar frontend policy over app-owned
editor text. So `docker exec -it web bash` can become an invocation that carries
the bootstrap itself, with no injection into an unknown tty at all.

**But there is no generally transparent rewrite.** Aliases and functions change
what `ssh` means; `command`, `env`, `exec`, `noglob`, `builtin` and prefix
assignments change resolution; pipelines, redirections, heredocs and multiline
documents make "the ssh command" an AST problem; `-t`/`-T`/`-tt` differ;
replacing the executable changes signals, process groups and exit status; and
the shell's own history records what the shell received, so a silent rewrite
falsifies the user's history.

Therefore, bounded hard: never rewrite arbitrary text; recognise only a strictly
parsed **simple command** with an allowlisted executable and a supported option
grammar; require an explicit *Run with integration*; carry **both**
`typedCommand` and `executedCommand` into the receipt and the ledger, visibly;
`exec` the real command from the adapter so exit status and signals stay
transparent; and on any parsing ambiguity, send the editor document unchanged.

**Open scope question — see §12.**

## 6. Capability tiers

| tier | where | gives | lacks |
|---|---|---|---|
| `enhanced` | bash ≥ 4.0 / zsh, launcher acknowledged | blocks, cwd, DOM editor owns input, recall, OSC 636 snapshot | — |
| `blocks` | bash/zsh without marker-only | blocks A/B/C/D, cwd, exit status; native input | editor, ghost-text |
| `minimal` | dash / busybox ash / POSIX sh | A, B, D and OSC 7 via `PS1` | C ("running"), snapshot, editor |

`minimal` is **verified, not assumed**. `docker run --rm -e 'PS1=<A>e=$? cwd=$PWD<B>'
alpine:latest sh -c 'printf "true\nfalse\ntrue\nexit\n" | sh -i'` yields
`e=0, e=0, e=1, e=0` — busybox ash re-expands `PS1` per prompt with a correct
`$?`. Identical under dash on `debian:stable-slim`. Two constraints follow: the
assignment must be **single-quoted** or `$?` freezes at install time, and the
exit status must be captured **before** any command substitution used to build
OSC 7, which would otherwise clobber it.

POSIX `sh` has no preexec hook, so C is out of reach *through portable prompt
hooks* — a chosen portability boundary, not a theorem. A block therefore appears
already finished, with no running phase; the block state machine must model that
transition explicitly rather than treating it as a lost marker.

Warp cannot reach this tier at all: its bootstrap is `read -r -d ''`, a bashism.
`docker exec -it web sh` into Alpine is its blind spot and our most common
nested case.

**Degradation is a product surface** (AGENTS.md). The tier is an environment
facet with its own confidence, always rendered — never "no chip" but `minimal`,
never `enhanced` when unsure but `unknown`, with the reason available.

**Fail-open is absolute** (ADR-0004:60, ADR-0006 §5). A failure at any step
leaves an ordinary terminal with a visible native prompt.

## 7. Security, stated honestly

**The nonce is a correlation token, not authentication.** Same-PTY shell
integration cannot authenticate against a hostile process holding that PTY: a
nonce travelling in the terminal byte stream is readable by anything sharing it.
It buys framing and accidental-spoof resistance. Revision 1 called it a security
boundary; it is not.

**The first-hello race is real.** `command-snapshot.ts:163` accepts the first
hello and discards the rest — correct *today* because the script speaks before
any user command can run (`command-snapshot.ts:21`). nocxify operates after
arbitrary processes have run, which destroys that precondition and turns
"accepted exactly once" into a weapon: an attacker who speaks first poisons the
nonce permanently.

**Therefore ownership is granted only by provenance.** `enhanced` requires that
nocx itself established the startup interval and received a launcher readiness
message. Integration reached any other way is capped at `blocks` until the user
confirms. Ownership begins only after readiness plus a clean A→B, ends at
submit/C/alternate-buffer/marker anomaly, and cannot resume without another
clean A→B (ADR-0006:77).

**The launcher is visible in remote process arguments and server audit logs**,
so it carries no secret and no session authentication material.

**History.** The remote shell's live and persisted history must contain exactly
what the shell executed, and the nocx ledger exactly what the user typed. Where
an explicit adapter makes them differ, both values and the reason are shown. A
silent mismatch is forbidden; so is deleting "the last N entries", which races
concurrent shells and can destroy the user's own commands.

**What we stop doing.** `EnsureInstalledRemote` leaves the default path. Writing
to another machine's home directory becomes something the user asked for, with
the diff shown first and an uninstall after.

## 8. Surfaces

Every control comes from `frontend/src/ui/` — the kit already has what this
needs, so nothing bespoke is built.

- **The environment indicator** (`nocx-uahp.4`) gains an `integration` facet:
  `enhanced | blocks | minimal | none | unknown`, always visible. `Badge` /
  `StatusDot` tones.
- **The receipt appears only when there is news** — first integration of an
  environment, degradation below the expected tier, refusal, a cleanup failure,
  or an adapter rewrite. A clean automatic integration writes nothing to the
  scrollback; the chip flips and that is all. Expanded, it states the strategy,
  the tier, what was written and removed, and offers *Install permanently* /
  *Disable here*.
- **The indicator popover** (`FloatingPanel`) carries the same facts for a
  session with no receipt, plus *Restore native prompt*. The UI distinguishes
  **input returned** (ours to guarantee) from **prompt restored** (needs shell
  cooperation) — revision 1 conflated them.
- **A bootstrap transcript**, payload excluded: strategy, start and end, shell
  evidence, tier negotiated, bytes sent, acknowledgements, termios changes, disk
  effects, cleanup. This is what makes a soft degrade diagnosable.
- **A Settings panel** lists hosts carrying a persistent install with an
  auditable manifest — paths, hashes, insertion anchor — and removes only bytes
  whose hash still matches, presenting a three-way diff otherwise.

## 9. Repairs folded in

- `nocx-zys2` — remote `VERSION` written before the gates.
- `nocx-difd` — `ssh -G` must surface `RemoteCommand` (and `RequestTTY`).
- `RemoteStartCommand` becomes a typed `RemoteLauncher`; the `-l`/`.bashrc`
  mismatch dies with the default SFTP path.
- `docs/architecture.md:203` names the Tier-B **helper binary** "Warpify Tier-B
  remote helper" and defers it. Warp's warpify is Tier A shell hooks — this
  epic, not deferred. Renamed here.

## 10. Acceptance, as assertions

Authored before implementation (AGENTS.md rule 4), stated as intervals where the
invariant is one (rule 3).

1. **Happy path.** Against a real sshd running bash, a user composes
   `printf nocx-ok` in the DOM editor, submits once, sees exactly one `nocx-ok`,
   gets A→B→C→D with exit 0, regains ownership, and recalls the command.
2. **bash startup equivalence.** For login and non-login fixtures, native SSH and
   nocxified SSH produce the same declared snapshot — exported variables, cwd,
   umask, aliases/functions, shopt state, traps, history settings, `$0`/login
   status, startup-file trace — excluding documented nocx names.
3. **zsh startup equivalence.** The same, plus `ZDOTDIR` unset-vs-set state,
   RCS/GLOBAL_RCS behaviour, global/user ordering, setopts, hooks and widgets.
4. **Exclusive interval.** From the first bootstrap byte until verified
   readiness, no user byte reaches the channel; a draft typed beforehand survives
   byte-for-byte and is submitted only after readiness.
5. **Termios interval.** If bootstrap changes termios at T1, the exact
   pre-bootstrap `stty -g` value is restored before T2, and no user startup file
   or input-reading command executes in `[T1,T2)` — asserted from the event
   trace, not the final state.
6. **Partial failure at every boundary** — before decode, during decode, before
   exec, during our rc, during the user's rc, before readiness, after readiness.
   Before readiness input stays disabled; after failure either the PTY closes or
   a visible native prompt with raw input is proven. Nothing reports `enhanced`.
7. **Transient zsh artifact.** It exists only from successful `mkdir` until
   before the first user startup command, mode 700 with its file 600 throughout;
   after success, exit, syntax failure, Ctrl-C and disconnect it is absent — or
   surfaced as a cleanup failure naming its exact path.
8. **No bash footprint.** A filesystem event monitor — not recursive mtimes —
   observes no nocx-created or modified remote path during bash startup.
9. **`RemoteCommand` preserved.** No replacement launcher is sent; the configured
   behaviour runs; `integration: none`, reason `remote-command`; session usable.
10. **`ForceCommand` degradation.** Absence of readiness never enables ownership;
    the forced command receives no bootstrap remainder and stays usable.
11. **Restricted shell preserved.** Never bypassed by invoking bash/zsh directly;
    no payload delivered; the reason is stated.
12. **Unsupported hosts.** sh-only, read-only home, no temp, Windows — each
    produces its specified tier or `none`; none is mislabelled; none receives
    syntax for a shell it does not run.
13. **User startup wins.** An rcfile that `exit`s, `exec`s or returns early gets
    no replacement shell and no later injection.
14. **History truth.** After one nocxified command, live and persisted remote
    history hold exactly what the shell executed and the ledger exactly what the
    user typed; any difference is visible with its reason.
15. **No silent rewrite** *(this epic: holds vacuously — nothing rewrites a
    command yet, and the assertion is what keeps it that way)*. Aliases,
    functions, pipelines, redirections, multiline input, `--` and conflicting
    TTY flags all send the editor document unchanged.
16. **Adapter transparency** *(owned by `nocx-eepi`, not asserted here)*. Per
    adapter: exit 0, nonzero, signal termination, Ctrl-C, Ctrl-Z, resize and
    disconnect match the unwrapped command.
17. **Ownership interval.** Ownership begins only after readiness plus a clean
    A→B, ends at submit/C/alternate-buffer/anomaly, and cannot resume without
    another clean A→B.
18. **Policy cascade.** Table-driven proof of profile → nearest group →
    ancestors → global → hardcoded, including explicit `off`, across storage,
    resolution, JSON-RPC and the real byte stream.
19. **Reconnect boundary.** A reconnected channel never inherits `enhanced`
    without fresh readiness and A→B.
20. **The journey.** One e2e run: real sshd, a command through the DOM editor,
    one nested environment entered through the explicit action, a failing command
    there with the right environment identity and exit status, recall, exit to
    the parent, ownership restored.

`cmd/devharness` runs the real backend headless, so this is reachable.

## 11. Explicitly out of scope

- The Tier-B helper: remote file tree, remote editing, codebase indexing.
- `fish`. Windows remote hosts. Port forwarding (`nocx-wzc4`).
- Re-integration after reconnect (`nocx-9le.7` owns reconnect; assertion 19
  fixes the boundary rather than crossing it).
- Automatic repair of drifted rc files — detect and offer a diff; do not become
  a remote dotfile manager.

## 12. Scope, decided

**This epic ships nocx-opened SSH plus the explicit in-band fallback.** The
`docker exec` / `sudo` / `su` adapters of §5.3 move to a follow-on epic: each is
a separate command grammar, and the transparency obligations (assertions 14–16)
are per-adapter work that would otherwise hold the SSH repair hostage.

Consequences, taken deliberately:

- `nocx-pu4`'s DONE WHEN narrows to SSH and jump host. It no longer claims
  docker/tmux depth, because the epic will not deliver it. Assertion 20's
  "nested environment entered through the explicit action" is satisfied by the
  in-band fallback (§4.4), which does work at depth — by hand, on the user's
  explicit action, with no adapter.
- §5.3 stays in this spec as the design the follow-on epic implements, so the
  bounds (allowlisted simple commands, `typedCommand` vs `executedCommand`,
  ambiguity sends the document unchanged) are settled before anyone writes an
  adapter, not after.
