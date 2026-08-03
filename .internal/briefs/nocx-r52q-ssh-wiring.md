# Brief — nocx-r52q: the SSH path stops editing other people's rc files

You are a supervised worker. Read this whole file before touching anything.

## Ground rules

- **Do not commit, push, or create a branch.** The coordinator integrates.
- **Do not touch `bd`.** Beads lives in a Dolt database git does not carry.
- **Do not run repo-wide gates** (no `go test ./...`). **Do run**
  `go build ./...`, `go vet ./internal/ssh/...` and
  `golangci-lint run ./internal/ssh/...`. That last is scoped to your package
  and is **not** optional — an earlier worker in this epic shipped a `gosec`
  finding because its brief forgot to name it.
- You own `internal/ssh/ssh.go`, `internal/ssh/ssh_real.go`, their tests, and
  `internal/session/session.go` if the seam needs it. **Another worker is
  creating `internal/shellintegration/launcher*.go` in a separate worktree — do
  not create or edit anything under `internal/shellintegration/`.**
- Report **numbers, not adjectives**.
- Heartbeat at every phase change (bottom of this file).

## Baseline

`go test ./internal/ssh/...` passes — measured, ~1.4s.

## Read first

`.internal/specs/2026-08-03-nocxify-design.md` §1 (defects 1 and 2), §4.2, §7.

## What is wrong today

`internal/ssh/ssh_real.go:507` calls `EnsureInstalledRemote` on **every** SSH
connect: it SFTPs `~/.nocx/` onto the remote host and appends a gate line to the
remote `~/.bashrc` / `~/.zshrc`, silently, without asking. Then it starts
`NOCX_SHELL_INTEGRATION=1 exec "${SHELL:-/bin/sh}" -l`.

`-l` is a **login** shell. bash then reads `~/.bash_profile`, not `~/.bashrc` —
so the gate that was just appended is in a file the shell never sources. We pay
the entire cost of mutating a stranger's server and receive nothing for it.

That path stops being the default in this task.

## The interface you code against — pinned, do not change it

The other worker is building exactly this, in parallel. It does **not exist in
your worktree**; you are writing the caller against the signature. If you need
it different, **escalate** — do not invent a variant.

```go
// package shellintegration

type ShellKind string
const (
	ShellBash    ShellKind = "bash"
	ShellZsh     ShellKind = "zsh"
	ShellUnknown ShellKind = "unknown"
)

type RefusalReason string
const (
	ReasonNone             RefusalReason = ""
	ReasonUnsupportedShell RefusalReason = "unsupported-shell"
	ReasonNoSecureTemp     RefusalReason = "no-secure-temp"
	ReasonRemoteCommand    RefusalReason = "remote-command"
)

type LaunchOptions struct {
	SessionID string
	Enhanced  bool
}

type RemoteLauncher interface {
	StartCommand(shell ShellKind, opts LaunchOptions) (cmd string, reason RefusalReason, ok bool)
}
```

Because the implementation is not here, **depend on the abstraction and test
against a fake** — which is the house rule anyway (`AGENTS.md`: interface-first
plus DI, wired at one composition root). Declare the interface you need in
`internal/ssh` or take it as a parameter; the other worker's concrete type will
satisfy it. Do not stub the concrete implementation.

## What to build

1. `openShell` stops calling `EnsureInstalledRemote` on the default path.
2. It asks the launcher for a start command, and **falls back to a plain shell
   with a typed reason** whenever the launcher declines or errors. The fallback
   must leave an ordinary, usable terminal with a visible native prompt — this
   is `ADR-0004:60` and it is absolute: no failure path may leave a session with
   a suppressed prompt and no input owner.
3. **The `RemoteCommand` refusal.** `HostConfig` now carries `RemoteCommand`
   (landed in this epic as `nocx-difd`). When it is non-empty, OpenSSH refuses to
   also run a command-line remote command and aborts the connection with
   *"Cannot execute command-line and remote command."* So: send **no** launcher,
   run the configured behaviour, and report `ReasonRemoteCommand`. Note that
   `ssh -G` renders "unset" either as an absent line or as the literal `none`
   depending on version, and both already collapse to the empty string in
   `HostConfig` — so the test really is "non-empty".
4. The refusal reason must be **reachable by the caller** — a reason that only
   ever reaches a log is the soft-degrade-invisible-in-the-product failure
   `AGENTS.md` names. Surface it on the session/channel so the transport can
   carry it later. You do not have to render it; you have to make it available.

## Choosing the shell — a stated limitation, not a guess

Nothing yet tells us reliably which shell is at the far end. For this task pass
`ShellBash` and let the launcher refuse what it cannot do. **Say so in a
comment**, naming it as a temporary default rather than a decision. Do not
invent a probe, do not sniff the banner (AD-6 forbids the backend reading the
byte stream), and do not read `$SHELL` over a second connection.

## Test first

Red before green, against a fake launcher. Cover:

- launcher accepts → its command is what `Start` receives;
- `RemoteCommand` non-empty → launcher is **never called**, and the reason is
  `remote-command`;
- launcher declines → plain shell, reason propagated, session usable;
- launcher returns an error → same;
- and for every one of those, assert the session is usable afterwards rather
  than only that the right branch was taken.

For every external call your code makes there must be a test where that call
fails — that is `AGENTS.md` rule 3 and it is the highest-yield check in the file.

## Explicitly out of scope

Building the launcher. Rendering the reason in the UI. Shell negotiation.
Removing `install_remote.go` — it stays as an implementation for the later
opt-in persistent install; only its use as the **default** goes away.

## When you are done

```bash
orca orchestration send --type worker_done --subject "<one-line status>" \
  --body "<what changed, test counts before/after, how a caller reaches the refusal reason, anything you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
```

`--outcome failed` if you did not finish.

```bash
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<reading|red|green|verifying>" --json
```
