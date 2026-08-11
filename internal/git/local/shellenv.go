package local

import (
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shady2k/nocx/internal/git"
)

// The resolved environment (spec D6): git's subprocesses — notably the
// pre-commit hook — run with an environment resolved once from the user's
// shell, not with the backend's own. A GUI-launched app inherits a bare
// launchd PATH from os.Environ(), so a commit from the panel would run its
// hook with no way to find go, node or bd, and fail where the terminal
// succeeds. The pty's shell starts interactive from
// scrubLauncherSession(os.Environ()) plus terminal vars and reads the rc
// files; the resolved environment is the closest a subprocess can get
// without a shell of its own, and the two are named in the product.
//
// The guarantee is deliberately narrow: an environment resolved once at
// backend start cannot contain anything created inside a tab after it
// started — a direnv, a virtualenv, an export the user typed — and AD-6
// forbids learning it from the stream. The panel says so, and a hook that
// passes in the terminal but fails here is an explicable difference rather
// than a mystery.
//
// Resolution is off Open's critical path (nocx-6pz0): the factory resolves
// once, in the background from construction, and Open reads the settled
// answer, so opening a repository costs what git costs and a hung rc file
// never holds the panel. Only the commit path blocks on resolution, joining
// the shared attempt or retrying a remembered failure after a cooldown, so
// D6's guarantee — the commit runs with the resolved environment when one is
// obtainable — still holds. The invocation below is unchanged (`-i`, 5 s
// default): it is the only non-pty way to read the rc files the way the
// pty's shell reads them, and the cost is now paid once in the background,
// not on every open.
type envCache struct {
	mu       sync.Mutex
	shell    string
	timeout  time.Duration
	maxOut   int64
	cooldown time.Duration // pause after a failed attempt before retrying
	env      []string
	state    envState  // envUnknown, envResolved or envDegraded
	reason   string    // why degraded; the panel's text
	lastTry  time.Time // when the last attempt settled; zero: never attempted
	inflight bool
	done     chan struct{} // non-nil while an attempt runs; closed when it settles
}

// envState is the resolver's own state machine, one step richer than the
// wire's: unknown is the pre-attempt state the wire reports conservatively
// as degraded, never as resolved.
type envState int

const (
	envUnknown envState = iota
	envResolved
	envDegraded
)

// envRetryCooldown is the pause after a failed resolution attempt before the
// next caller may retry. One failure is plausibly transient (a hung rc file,
// a missing shell) and deserves a second chance; a permanently broken shell
// must not turn every commit into a timeout, and a cooldown is the bound
// that says so. Chosen well above the resolution deadline so a machine whose
// shell always hangs retries at most a handful of times an hour, and well
// below any realistic poll cadence so a recovery is picked up promptly.
const envRetryCooldown = 30 * time.Second

// newEnvCache builds the resolver: shell is the binary to interrogate
// ("" — detect, like the pty does), timeout and maxOut bound one attempt.
// A success is cached; a failure is remembered for the cooldown and retried
// after it, so the cache resolves at most once per cooldown window.
func newEnvCache(shell string, timeout time.Duration, maxOut int64) *envCache {
	if shell == "" {
		shell = detectShell()
	}
	// The 5 s default is deliberate (nocx-6pz0): it no longer holds a UI —
	// resolution runs in the background and only a commit joins it — and a
	// shorter bound would degrade slow-but-healthy shells (a large rc, a
	// network mount), weakening D6's "when one is obtainable".
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	if maxOut <= 0 {
		maxOut = 256 << 10
	}
	return &envCache{shell: shell, timeout: timeout, maxOut: maxOut, cooldown: envRetryCooldown}
}

// resolve returns the cached environment, resolving it on demand. A completed
// resolution is cached for the process lifetime; a failed one is remembered
// for the cooldown and retried after it, so a transient failure (a hung rc
// file, a missing shell) degrades some opens and recovers — it neither
// re-attempts on every call nor poisons the panel for the process lifetime.
// Attempts are single-flight: a caller that arrives while one runs joins it
// instead of starting a second shell.
func (c *envCache) resolve(ctx context.Context) (env []string, state git.EnvState, reason string) {
	for {
		c.mu.Lock()
		if c.state == envResolved {
			env, state, reason = c.env, git.EnvResolved, ""
			c.mu.Unlock()
			return
		}
		if c.state == envDegraded && time.Since(c.lastTry) < c.cooldown {
			env, state, reason = nil, git.EnvDegraded, c.reason
			c.mu.Unlock()
			return
		}
		if c.inflight {
			done := c.done
			c.mu.Unlock()
			select {
			case <-done:
				continue // the attempt settled; re-read the answer
			case <-ctx.Done():
				return nil, git.EnvDegraded, ctx.Err().Error()
			}
		}
		c.inflight = true
		c.done = make(chan struct{})
		c.mu.Unlock()

		env, err := resolveShellEnv(ctx, c.shell, c.timeout, c.maxOut)
		c.mu.Lock()
		c.lastTry = time.Now()
		c.inflight = false
		close(c.done)
		if err != nil {
			c.state, c.reason = envDegraded, err.Error()
			c.mu.Unlock()
			return nil, git.EnvDegraded, err.Error()
		}
		c.env, c.state, c.reason = env, envResolved, ""
		c.mu.Unlock()
		return env, git.EnvResolved, ""
	}
}

// known returns the current answer without attempting or waiting: the
// resolved environment, a remembered failure, or — before the background
// attempt settles — a conservative degraded. Open uses this: the repository
// answer must not wait on the resolution (nocx-6pz0), and the panel must
// never be shown a "resolved" the resolution has not earned.
func (c *envCache) known() (env []string, state git.EnvState, reason string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch c.state {
	case envResolved:
		return c.env, git.EnvResolved, ""
	case envDegraded:
		return nil, git.EnvDegraded, c.reason
	default:
		return nil, git.EnvDegraded, "the shell environment has not been resolved yet; the first commit will wait for it"
	}
}

// waitSettled blocks until no resolution attempt is in flight. Factory.Stop
// cancels the background attempt and calls this so no resolution child can
// outlive the process.
func (c *envCache) waitSettled() {
	for {
		c.mu.Lock()
		if !c.inflight {
			c.mu.Unlock()
			return
		}
		done := c.done
		c.mu.Unlock()
		<-done
	}
}

// envDumpMarker separates whatever the rc files printed on their way past —
// a greeting, a version notice, a fastfetch — from the environment dump that
// follows it. Everything before the first occurrence is discarded; the bytes
// after it are the dump and nothing else, because `exec` leaves no shell
// behind to write again.
const envDumpMarker = "\n__nocx_env_dump__\n"

// resolveShellEnv runs the user's shell interactively — so it reads the rc
// files the way the pty's shell does — and then EXECS `env -0`, so what
// arrives is the exported environment a child of that shell would actually
// receive, NUL-delimited. Bounded by a deadline and an output cap, both
// enforced by the same machinery git itself runs under: the deadline is the
// run spec's wall-clock ceiling and the cap is the stdout sink's, so a hung
// rc file or a chatty one cannot hold the resolver open.
//
// The `-i` is what makes the shell read its rc files the way the pty's shell
// does (nocx-6pz0); a non-pty reimplementation of rc loading (sourcing
// ~/.bashrc by hand) would be a second answer that diverges from the pty's
// shell startup, and an interactive shell without a tty hanging in an rc file
// is a bounded, remembered failure, no longer a cost every open pays.
//
// `env -0` rather than `export -p`, which is what this ran until nocx-58gq.
// POSIX says `export -p` writes the exported variables in a re-enterable
// form; zsh does not write the ones tied to an array — PATH, FPATH and SHLVL
// — so on macOS, whose default shell IS zsh, the resolver read an
// environment with no PATH on EVERY machine and D6 degraded for every user of
// the shipping platform. There is no portable `export -p` incantation that
// includes them (`typeset -x` is not in dash), and the paired-success test
// was reporting it the whole time from the one shell CI does not run
// (AGENTS.md rule 2). `env` is the same question asked of the kernel instead
// of the shell: it needs no un-quoting, it cannot disagree with itself
// between shells, and it is literally the environment a child gets — which is
// what D6 hands to git. Absolute path because a broken PATH is one of the
// states this must still resolve through; a missing /usr/bin/env fails the
// exec and degrades with the shell's exit status, which is honest.
func resolveShellEnv(ctx context.Context, shell string, timeout time.Duration, maxOut int64) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// The shell starts from the same scrubbed launcher environment plus
	// terminal vars as the pty's shells (pty_local.go:132), so the resolved
	// environment and the tab's agree about everything except what the tab
	// created itself. The scrub list and the locale gap-fill are copied from
	// internal/pty rather than imported: they are that package's private
	// vocabulary, and the comment naming this copy is what keeps the two in
	// step.
	sink := &byteSink{max: maxOut}
	res := run(ctx, spec{
		argv:      []string{shell, "-i", "-c", "printf '" + envDumpMarker + "'; exec /usr/bin/env -0"},
		env:       withUTF8Locale(append(scrubLauncherSession(os.Environ()), "TERM=xterm-256color", "COLORTERM=truecolor")),
		sink:      sink,
		deadline:  time.Now().Add(timeout),
		stderrMax: 64 << 10,
	})
	if res.cancelled {
		return nil, ctx.Err()
	}
	if res.err != nil {
		return nil, res.err
	}
	if res.exitCode != 0 {
		return nil, &degradedError{reason: "the shell exited " + strconv.Itoa(res.exitCode) + " while resolving the environment"}
	}

	env, err := parseEnvDump(string(sink.buf))
	if err != nil {
		return nil, &degradedError{reason: err.Error()}
	}
	if !hasPATH(env) {
		return nil, &degradedError{reason: "the shell resolved an environment with no PATH"}
	}
	return env, nil
}

// degradedError is a plain reason carrier; the distinction the product needs
// is the EnvState, and the reason is the panel's text.
type degradedError struct{ reason string }

func (e *degradedError) Error() string { return e.reason }

func hasPATH(env []string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") && len(kv) > len("PATH=") {
			return true
		}
	}
	return false
}

// parseEnvDump parses the NUL-delimited output of `env -0` that follows
// envDumpMarker. Everything before the marker is whatever the rc files
// printed and is discarded; each record after it is one NAME=VALUE exactly as
// the kernel holds it, so there is no quoting to undo and a value containing
// a newline, a space or a quote survives verbatim.
//
// A record whose name is not a valid environment-variable name is dropped
// rather than failing the resolution: it is the shape a stray write from a
// background job in an rc file takes, and one of those must not cost the user
// the whole environment.
//
// PWD is dropped: it is per-process state, and the stale copy the shell
// exported would lie to hooks about where they are.
func parseEnvDump(out string) ([]string, error) {
	i := strings.Index(out, envDumpMarker)
	if i < 0 {
		return nil, &degradedError{reason: "the shell printed no environment dump"}
	}
	var env []string
	for _, record := range strings.Split(out[i+len(envDumpMarker):], "\x00") {
		eq := strings.IndexByte(record, '=')
		if eq <= 0 {
			continue // the trailing empty record, or a name-less fragment
		}
		name := record[:eq]
		if !validName(name) || name == "PWD" {
			continue
		}
		env = append(env, record)
	}
	return env, nil
}

func validName(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c == '_':
		case c >= '0' && c <= '9' && i > 0:
		default:
			return false
		}
	}
	return true
}

// detectShell mirrors the pty's shell detection (pty_local.go:114): the
// user's SHELL when set, otherwise a fallback chain ending at /bin/sh. On a
// GUI-launched app SHELL may be absent, which is exactly the launch shape the
// resolver exists for.
func detectShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	for _, candidate := range []string{
		"/run/current-system/sw/bin/bash", // NixOS
		"/bin/bash",
		"/usr/bin/bash",
		"/usr/local/bin/bash",
		"/bin/sh",
	} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "/bin/sh"
}

// launcherSessionVars mirrors internal/pty/pty_local.go's list, kept in step
// by this comment: the pty scrubs these from its shells' environment so a
// coding agent's session markers do not leak into spawned programs, and the
// resolved environment must match what the pty's shell sees — a pre-commit
// hook that invokes the same agent would otherwise inherit the same markers.
var launcherSessionVars = []string{
	"CLAUDECODE=",
	"CLAUDE_CODE_ENTRYPOINT=",
	"CLAUDE_CODE_EXECPATH=",
	"CLAUDE_CODE_SESSION_ID=",
	"CLAUDE_CODE_CHILD_SESSION=",
	"CLAUDE_PID=",
	"CLAUDE_EFFORT=",
	"NO_COLOR=",
	"TERM=",
}

func scrubLauncherSession(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		drop := false
		for _, prefix := range launcherSessionVars {
			if strings.HasPrefix(kv, prefix) {
				drop = true
				break
			}
		}
		if !drop {
			out = append(out, kv)
		}
	}
	return out
}

// localeVars are checked in POSIX precedence order, the same list the pty
// uses; the gap-fill keeps git's output (and a hook's) on a UTF-8 locale
// when the launcher environment declares none.
var localeVars = []string{"LC_ALL=", "LC_CTYPE=", "LANG="}

func withUTF8Locale(env []string) []string {
	for _, kv := range env {
		for _, prefix := range localeVars {
			if strings.HasPrefix(kv, prefix) {
				return env
			}
		}
	}
	return append(env, "LANG=en_US.UTF-8")
}
