# Brief — nocx-xs1d: the launcher

You are a supervised worker. Read this whole file before touching anything.

## Ground rules

- **Do not commit, push, or create a branch.** The coordinator integrates.
- **Do not touch `bd`.** Beads lives in a Dolt database git does not carry, so
  `bd show` finds nothing here. Everything you need is in this file and in the
  tracked spec it names.
- **Do not run repo-wide gates** (no `go test ./...`). **Do run**
  `go build ./...`, `go vet ./internal/shellintegration/...`, and
  `golangci-lint run ./internal/shellintegration/...` — that last one is not
  optional and is not a repo-wide gate for your purposes: it is scoped to your
  package, and a previous worker in this epic shipped a `gosec` G204 finding
  because its brief forgot to name it. An error in a file you do not own:
  **report it, do not fix it**.
- You own **new files** `internal/shellintegration/launcher*.go` and their
  tests. You may add to `scripts.go` only if you must. **Another worker is
  editing `internal/ssh/ssh_real.go` and `internal/ssh/ssh.go` in a separate
  worktree — do not touch `internal/ssh/` at all.**
- Report **numbers, not adjectives**.
- Heartbeat at every phase change (bottom of this file).

## Baseline

`go test ./internal/shellintegration/...` passes — measured, ~4.0s.

## Read first

`.internal/specs/2026-08-03-nocxify-design.md` §4.1, §4.2, §4.3. It is tracked
and in this worktree. This brief does not repeat it; it pins the interface and
names the traps.

## The interface — pinned, do not change it

Another worker is writing the caller against exactly this, in parallel, in
another worktree. If you need it different, **escalate**; do not improve it.

```go
// ShellKind names the far shell a launcher builds a start command for.
type ShellKind string

const (
	ShellBash    ShellKind = "bash"
	ShellZsh     ShellKind = "zsh"
	ShellUnknown ShellKind = "unknown"
)

// RefusalReason is why integration did not happen, in a form the product
// renders. The empty string means "no refusal".
type RefusalReason string

const (
	ReasonNone             RefusalReason = ""
	ReasonUnsupportedShell RefusalReason = "unsupported-shell"
	ReasonNoSecureTemp     RefusalReason = "no-secure-temp"
)

// LaunchOptions carries what the start command must embed.
type LaunchOptions struct {
	SessionID string // NOCX_SESSION_ID for this session; never empty when Enhanced
	Enhanced  bool   // request marker-only prompt mode (ADR-0006)
}

// RemoteLauncher builds the command string passed to an SSH session's
// Start() to bring up an integrated interactive shell on the far host.
type RemoteLauncher interface {
	// StartCommand returns the remote command for the given far shell.
	// ok is false when this shell cannot be integrated; reason then says
	// why, and the caller falls back to a plain shell.
	StartCommand(shell ShellKind, opts LaunchOptions) (cmd string, reason RefusalReason, ok bool)
}
```

## bash — no remote write

```sh
/bin/bash -c 'exec bash --rcfile <(printf %b "<escaped-init>") -i'
```

The explicit `/bin/bash -c` is the point, and it was measured: `bash --rcfile
<(...)` is a **bashism**. Under `dash` it dies with `Syntax error: "("
unexpected`, and sshd hands a remote command to the user's _login_ shell, which
may be dash, ash, csh or a restricted shell. Never emit bare process
substitution and hope.

- Use bash's **builtin** `printf`, not `/usr/bin/printf` — the external path is
  not portable.
- The payload must contain **no NUL**.
- Cap the whole launcher well below a conservative remote `ARG_MAX`, and say in
  a comment what number you chose and why.
- Quote the outer `-c` argument with a real single-quote escaper, not string
  concatenation that happens to work on your test input.

## zsh — a transient directory, and it must erase itself

zsh has no `--rcfile`. `ZDOTDIR` names a _directory_ and cannot name a pipe, so
the transient directory is structural, not a shortcut. `umask 077`, `mkdir` it,
write `.zshrc`, `export ZDOTDIR`, `exec -l zsh`.

The generated `.zshrc` must, in this order: capture the bootstrap dir and the
original `ZDOTDIR`; **remove its own file and directory before any user code
runs**; restore `ZDOTDIR` — preserving the original _unset-versus-set_ state,
not merely its string value; source the user's real startup file from the
original location; and only then install nocx's hooks. A trap must cover a
partial startup.

## What the init payload must get right

§4.3 of the spec is the list; treat it as the acceptance surface, not as
background reading. The two that bite hardest:

- **User startup wins.** If the user's rcfile `exec`s, `exit`s or returns early,
  nocx does not start a replacement shell and does not inject afterwards.
  Integration simply does not happen.
- **nocx installs last.** ADR-0006 requires the prompt overlay to go in _after_
  prompt initialisation, or a framework regenerating `PS1` clobbers it.

Do not promise bit-for-bit environment identity. Promise, and test, a declared
equivalence set: exported variables, cwd, umask, shell options, functions and
aliases, traps, history configuration, `$0`/login status.

## Test first

Red before green. `scripts_exec_test.go` and `scripts_posix_exec_test.go` in
this package already drive real shells; extend that seam.

Assert at minimum:

- real bash launched by your command emits A and B markers;
- the user's own rcfile still ran (set a sentinel variable in a fixture rcfile
  and observe it);
- during a bash launch, **no path under `$HOME` is created or modified** —
  compare a listing before and after, and say in the message how you checked;
- real zsh via the transient dir: markers arrive, the user's `.zshrc` ran, and
  the transient directory is **gone before the first user command**;
- the transient directory is also gone after a syntax failure and after an early
  `exit` in the user's rcfile;
- `ShellUnknown` returns `ok == false` with `ReasonUnsupportedShell` and an
  empty command — never a best-effort guess.

If zsh is not installed here, get it (`nix shell nixpkgs#zsh` works in this
repo — a previous worker used it for dash and busybox). If you genuinely cannot,
**say so explicitly** in your completion message rather than skipping quietly.

## When you are done

```bash
orca orchestration send --type worker_done --subject "<one-line status>" \
  --body "<what changed, test counts before/after, which shells you actually exercised, how you checked the $HOME invariant, anything you could not verify>" \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --outcome succeeded \
  --files-modified "<paths>" --json
```

`--outcome failed` if you did not finish. Never encode failure only in prose.

```bash
orca orchestration send --type heartbeat --subject alive \
  --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> --phase "<reading|red|green|verifying>" --json
```
