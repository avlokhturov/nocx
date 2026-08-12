package pty

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"

	"github.com/creack/pty"
	"github.com/shady2k/nocx/internal/log"
)

type LocalPty struct {
	log    log.Logger
	cmd    *exec.Cmd
	file   *os.File
	mu     sync.Mutex
	done   chan struct{}
	closed bool
}

// localeVars are checked in POSIX precedence order; any one of them present
// means the environment already states a locale.
var localeVars = []string{"LC_ALL=", "LC_CTYPE=", "LANG="}

// launcherSessionVars identify the SESSION that launched nocx, not the user's
// environment. A terminal hands out shells; it must not hand out its
// launcher's identity with them. When nocx is started from inside a coding
// agent — which is exactly how it gets developed — every shell it spawns
// inherited that agent's session markers, and a `claude` run in a tab saw
// CLAUDE_CODE_CHILD_SESSION and silently disabled transcript saving.
//
// Deliberately a precise list rather than a CLAUDE* wildcard: stripping
// something like an API key would break the very tool we are trying to fix.
// It grows as other launchers are found.
//
// NO_COLOR= and TERM= belong to the same class of leak: coding agents run
// nocx's dev harness with TERM=dumb / NO_COLOR=1 in their tool environment,
// and every spawned shell then tells its TUIs "no colors here" — claude
// renders black-and-white. A terminal emulator declares color capability
// itself (TERM=xterm-256color + COLORTERM=truecolor are appended below);
// the launcher's opinion must not leak into the PTY.
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

// withUTF8Locale guarantees the child shell knows it is on a UTF-8 terminal.
// A GUI app launched from Finder or the Dock inherits none of the shell's
// environment, so without this the shell has no locale, and any Python/Rich
// TUI downstream encodes its output with errors="replace" — turning every
// non-ASCII glyph into a literal '?'. That failure is invisible when launched
// from a terminal, where LANG is inherited, and it masquerades as a font bug.
// Only fills a gap: an inherited locale, UTF-8 or not, is left alone.
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

// resolveCwd picks where the shell starts. A GUI app launched from Finder or
// the Dock inherits "/" as its working directory, which is useless as a
// starting point and useless as a tab name, so an unset Cwd falls back to the
// user's home the way Terminal.app and iTerm do.
func resolveCwd(cwd string) string {
	if cwd != "" {
		return cwd
	}
	if home, err := os.UserHomeDir(); err == nil {
		return home
	}
	return ""
}

// shellSource names where the shell a local session runs came from. It exists
// so the log line can distinguish "the environment asked for this one" from
// "we went looking and this is what the machine had" — two answers that need
// different fixes when a run drove a shell nobody expected.
type shellSource string

const (
	shellFromEnv      shellSource = "SHELL"
	shellFromDetected shellSource = "detected"
	shellFromFallback shellSource = "fallback"
)

// Preferred when $SHELL says nothing: bash is the tier the local enhanced
// bootstrap is written for (app.go starts `bash --rcfile`), not the only tier
// with shell integration — nocx.zsh emits the same OSC 133 markers and, since
// nocx-qduc, the same OSC 636 command snapshot. Fall back through common
// paths; on stripped-down containers none may exist, so keep /bin/sh as the
// last resort.
var shellCandidates = []string{
	"/run/current-system/sw/bin/bash", // NixOS
	"/bin/bash",
	"/usr/bin/bash",
	"/usr/local/bin/bash",
}

// resolveShell decides which shell a local session runs, and says where the
// answer came from. Both lookups are injected so the decision can be tested
// without a machine that happens to have the right binaries.
func resolveShell(lookupEnv func(string) string, exists func(string) bool) (string, shellSource) {
	if shell := lookupEnv("SHELL"); shell != "" {
		return shell, shellFromEnv
	}
	for _, candidate := range shellCandidates {
		if exists(candidate) {
			return candidate, shellFromDetected
		}
	}
	return "/bin/sh", shellFromFallback
}

func NewLocal(logger log.Logger, cfg Config, opts ...Option) (*LocalPty, error) {
	for _, opt := range opts {
		opt(&cfg)
	}

	// The launcher may name an explicit command (e.g. a lifecycle bootstrap
	// that must start bash with `--rcfile` so the per-epoch capability
	// rides script text, never the environment — nocx-u7uh.21). When
	// cfg.Command is empty the resolved interactive shell is used, exactly
	// as before.
	var cmd *exec.Cmd
	if cfg.Command != "" {
		cmd = exec.Command(cfg.Command, cfg.Args...) //nolint:gosec // the launcher names its own shell
	} else {
		shell, shellFrom := resolveShell(os.Getenv, func(p string) bool {
			_, err := os.Stat(p)
			return err == nil
		})
		// Logged, not merely decided. Which shell a session runs is the single
		// biggest thing that varies between two machines running the same code,
		// and each tier answers a different amount of the protocol — bash and
		// zsh emit the OSC 636 command snapshot (nocx-qduc gave zsh its half),
		// the POSIX tier emits none of it, so the shell still decides whether
		// tab completion ever learns a command name. This line is what lets a
		// run's account answer that without inference (nocx-z9s9.9).
		logger.Info("local pty shell resolved", "shell", shell, "source", string(shellFrom))
		cmd = exec.Command(shell, "-i") //nolint:gosec // shell is from detected path
	}
	cmd.Dir = resolveCwd(cfg.Cwd)
	env := withUTF8Locale(append(
		scrubLauncherSession(os.Environ()),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	))
	env = append(env, cfg.Env...)
	cmd.Env = env
	cmd.ExtraFiles = cfg.ExtraFiles

	f, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: cfg.Cols,
		Rows: cfg.Rows,
		X:    cfg.XPixel,
		Y:    cfg.YPixel,
	})
	if err != nil {
		return nil, err
	}

	lp := &LocalPty{
		log:  logger,
		cmd:  cmd,
		file: f,
		done: make(chan struct{}),
	}

	go func() {
		_ = cmd.Wait()
		close(lp.done)
	}()

	return lp, nil
}

func (lp *LocalPty) Read(p []byte) (int, error) {
	return lp.file.Read(p)
}

func (lp *LocalPty) Write(p []byte) (int, error) {
	return lp.file.Write(p)
}

func (lp *LocalPty) Close() error {
	lp.mu.Lock()
	defer lp.mu.Unlock()

	if lp.closed {
		return nil
	}
	lp.closed = true

	if lp.cmd.Process != nil {
		_ = lp.cmd.Process.Signal(syscall.SIGTERM)
	}
	return lp.file.Close()
}

func (lp *LocalPty) Resize(_ context.Context, cols, rows, xpixel, ypixel uint16) error {
	return pty.Setsize(lp.file, &pty.Winsize{
		Cols: cols,
		Rows: rows,
		X:    xpixel,
		Y:    ypixel,
	})
}

func (lp *LocalPty) Done() <-chan struct{} {
	return lp.done
}
