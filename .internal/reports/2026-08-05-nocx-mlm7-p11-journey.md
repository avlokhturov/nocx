# P11 — journey e2e run: FAILED at step 1 (environment-level blocker)

Bead `nocx-q3y9`. Date 2026-08-05. Worker `task_c50507f32dd6`.

## Verdict

The epic's acceptance criterion **cannot be observed on this machine in one
run** because the local OpenSSH client resolves `~/.ssh/config` (and
`~/.ssh/known_hosts`) from the **passwd home (`/home/dev`)**, never from the
disposable `$HOME` the e2e boundary exports. The alias `e2ehost` therefore
never resolves, ssh fails with "Could not resolve hostname", no password
prompt ever appears, and every downstream step of the journey is
unobservable. Per the brief ("do not change production code to make a test
pass — if the journey does not work, that is the finding … and stop") the run
was stopped; no production code was touched.

## What was built (deliverable, in the worktree)

- `e2e/nocxify-journey.spec.ts` — the acceptance spec: one serial run a
  person could have performed. Two real `cmd/e2e-sshd` fixtures (primary
  host with banner + password auth; a second "auth-failure" host), a
  disposable local home (`NOCX_E2E_HOME_DIR`) seeded with
  `~/.ssh/config` aliases + known_hosts, a **separate** remote home for the
  fixture (local `~/.nocx` and remote `~/.nocx` stay distinct), rc-file
  snapshots around the whole journey, and a Node mirror of Go's
  `Publisher.Verify` (lstat, no-symlink, hash+mode+size per file).
  Asserts, in order: frozen local block with banner + password prompt →
  remote blocks labelled `e2ehost` → exit + editor back → second connection
  carrying the compact `$HOME/.nocx/launch` line → auth failure showing the
  real exit status 255 → five rc files byte-identical → `~/.nocx` with
  exactly one active generation whose manifest verifies.
- `cmd/e2e-sshd/main.go` — fixture glue: `-banner <text>` (BannerCallback)
  and `-password <pass>` (password auth, fixture key refused) flags, plus a
  missing **exit-status** on session end (a real ssh client waits for
  exit-status + channel EOF; without it the fixture deadlocks and the
  journey's `exit` never terminates). Verified by direct ssh: banner,
  prompt, `JOURNEY-REMOTE-OK`, "Connection … closed.", exit code 7.

## The run

Headless stack per `nocx-headless-e2e-wiring`: devharness on
`127.0.0.1:9892` with `HOME=/tmp/nocx-e2e-journey/home` (+ XDG dirs),
vite on `:5192`, `PW_PROJECTS=chromium`, fresh disposable root. Run
duration ~34 s to first failure; three probe runs followed (~11 s each) to
isolate the cause.

## What happened, step by step (observed, with evidence)

1. **Submit `ssh e2ehost`** — `shell.launcherCommand` is sent with
   `oracleArgv ["ssh","-G","e2ehost"]` (WS capture). The backend answers:
   the renderer learns the minted environmentId and registers the attempt.
   Mode is **bootstrap** (no installed fact) — the oracle succeeds
   silently because `ssh -G e2ehost` **answers about the real home**:
   `/home/dev/.ssh/config` does not exist, so ssh -G reports defaults
   (`user dev`, `hostname e2ehost`, `port 22`) with no error. The staged
   launcher is written.
2. **The rewrite executes** — the local shell runs
   `if [ -s '<staged>' ]; then ssh -t e2ehost "$(cat '<staged>'; rm -f '<staged>')"; …`
   — proven by the staged file being **consumed** (`~/.nocx/run/` empty
   after the run).
3. **The connection cannot happen** — the local ssh client resolves
   `~/.ssh/config` from the **passwd home**, not `$HOME`. Decisive control:
   with `HOME=/tmp/ssh-home-test` and a valid `.ssh/config` present,
   `ssh -G probealias` returns `user dev / hostname probealias / port 22`
   (config ignored); `ssh -G -F <config> probealias` returns the configured
   values. `ssh -v -G` shows `userknownhostsfile /home/dev/.ssh/known_hosts`
   regardless of `$HOME`. This is OpenSSH 10.4p1 on this NixOS box
   (`/nix/store/c53dnjjglhynq6h3v7a96vyrpsb7zpcw-openssh-10.4p1/bin/ssh`).
4. **Result on screen**: the block freezes with `exit 255` and the output
   `ssh: Could not resolve hostname e2ehost: Name or service not known`.
   `shell.environmentObserved` fires with `passport: null` (correct — no
   passport, no entry). **No password prompt, no banner, no frozen-entered
   block, no remote block — every assertion after step 1 is unobservable.**

### Steps that could not be observed (all downstream of the blocker)

- Criterion 1: frozen local block containing banner + password prompt
  (the password prompt never appears).
- Criterion 2: remote command blocks labelled with the remote context.
- Criterion 3: `exit`, local blocks again, editor back.
- Criterion 4: second connection carrying the compact `~/.nocx/launch`
  line (the installed fact was never recorded — no passport ever).
- Criterion 5: auth failure showing the real exit status (the fail-host
  never gets a connection either).
- Criteria 6–7: rc files byte-identical and `~/.nocx` one active
  generation (nothing ever publishes to the remote home; verified only
  that `~/.nocx` on the remote home does **not** exist — no side effects).

## Why this is environment, not product

On a machine where `$HOME ==` the passwd home (standard Linux/macOS), the
typed-argv oracle and the user's ssh both read the real `~/.ssh/config`,
and the journey would run exactly as designed. The e2e home boundary
(home-isolation.ts) assumed `$HOME` redirects the ssh binary's config too;
on this OpenSSH build it does not. The resolver's `-F`-free typed-argv
oracle (`ssh_resolver.go` runSSHGArgv, nocx-c5az) is correct for normal
machines; it is only invisible to this fixture environment.

## What would make it observable (coordinator decision, NOT production code)

- A system-level `ssh_config.d` drop-in on the box pointing the user
  config at the disposable home (out of my package; touches the machine),
  or
- running the ssh binary with a uid whose passwd home is the disposable
  home, or
- accepting a typed line with `-F`/`-o` flags (changes the very
  person-typed form the criterion names — not done, per the brief).

Also observed (test-side, not the blocker): submitting `ssh e2ehost` on a
fresh session can race the local shell's first A marker
(`_shellIntegrated` gate in terminal-content.ts beforeSubmit), sending the
plain line. The spec waits for the editor, which can appear before the
first marker lands; a warmup command settles it. Moot until the blocker is
lifted, but worth knowing.

## Files

- `e2e/nocxify-journey.spec.ts` (new) — the acceptance spec; fails at
  step 1 in this environment, which is the finding.
- `cmd/e2e-sshd/main.go` (modified) — banner/password flags + exit-status
  delivery; build + vet clean; smoke-tested with the real ssh client.
