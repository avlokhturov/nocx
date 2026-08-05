package shellintegration

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/shady2k/nocx/internal/log"
)

// Staging the remote launcher for a HAND-TYPED ssh (nocx-pu4.6).
//
// The managed ssh path hands the launcher to sshd over the SSH protocol,
// where no line discipline is involved. A hand-typed `ssh user@host` has only
// the terminal: whatever we rewrite the line to must survive the tty. It
// cannot. A Linux canonical line buffer is 4096 bytes (N_TTY_BUF_SIZE) —
// measured on a real pty: 4095 bytes on one line survive intact, 8000 already
// lose data, 34856 come back as 27873 — and the ShellAuto launcher is 35243
// bytes, because it carries the bash, zsh and POSIX tiers so the far login
// shell can pick its own. The first attempt sent it inline and the shell
// executed the fragments of a truncated script.
//
// So the payload does not travel through the tty at all. The backend writes
// it to a private file and the renderer types only the PATH:
//
//	if [ -s '<path>' ]; then ssh -t <dest> "$(cat '<path>')"; else <original>; fi
//
// The local shell reads the file at execution time and hands the bytes to ssh
// through argv, which is bounded by ARG_MAX (~2 MB) rather than MAX_CANON.
// Command-substitution output is never re-scanned for expansion, so the
// literal `"$0"` inside the dispatcher still reaches the FAR login shell
// unexpanded — which is how it learns which shell it is (launcher_auto.go).
//
// Why a file and not an environment variable on the local pty: a variable is
// chosen when the shell is spawned, so a nested shell or a pre-existing tmux
// server hands a later tab a stale session id; it taxes every child exec with
// 35 KB, it is visible in /proc/<pid>/environ, and the user's rc can unset it.
// A path the backend picks per call is correct by construction.

// stageTTL is how long a staged launcher may sit before the next Stage
// removes it. The happy path consumes a file within milliseconds — the RPC
// returns, the renderer pastes, the shell runs — so nothing legitimate is
// ever this old, and an hour is far beyond any scheduling delay that could
// separate the write from the execution. Age is the only criterion that is
// safe when two backends share a home directory: neither can prune a file
// the other is still about to use.
const stageTTL = time.Hour

// stageDirName is the staging directory inside the integration directory.
const stageDirName = "run"

// LauncherStager puts a remote launcher where the LOCAL shell can read it and
// returns the absolute path. Behind an interface because the transport is
// wired at the composition root and must be able to fail-open on a stub.
type LauncherStager interface {
	// Stage writes launcher to a private file and returns its absolute
	// path. An error means the rewrite must be refused and the line the
	// user typed sent unchanged (ADR-0004 §1).
	Stage(launcher string) (string, error)
}

// fileStager is the production LauncherStager: one 0600 file per call in a
// 0700 directory under the user's integration directory.
type fileStager struct {
	log  log.Logger
	home string
}

// NewLauncherStager returns the production LauncherStager, staging under
// home/.nocx/run — the same directory the integration scripts already live
// in, so there is one place a user has to know about rather than two.
func NewLauncherStager(logger log.Logger, home string) LauncherStager {
	return &fileStager{log: logger, home: home}
}

func (s *fileStager) Stage(launcher string) (string, error) {
	if s.home == "" {
		return "", fmt.Errorf("shellintegration: no home directory to stage a launcher in")
	}
	dir := filepath.Join(s.home, dirName, stageDirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("shellintegration: create staging dir %s: %w", dir, err)
	}

	// Prune before writing, not after: the write is what the caller is
	// waiting on, and a prune that fails must not fail the stage.
	s.prune(dir)

	f, err := os.CreateTemp(dir, "launcher-")
	if err != nil {
		return "", fmt.Errorf("shellintegration: create staged launcher: %w", err)
	}
	path := f.Name()
	// CreateTemp is already 0600, but the mode is stated rather than
	// inherited: the file's contents become remote shell code the moment
	// the local shell reads it.
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("shellintegration: chmod staged launcher: %w", err)
	}
	// No trailing newline is added: the local shell reads this with
	// `$(cat …)`, and command substitution strips trailing newlines, so a
	// file that ended in one would not match the bytes it delivers.
	if _, err := f.WriteString(launcher); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("shellintegration: write staged launcher: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("shellintegration: close staged launcher: %w", err)
	}

	s.log.Debug("shellintegration: staged remote launcher", "path", path, "bytes", len(launcher))
	return path, nil
}

// prune removes staged launchers older than stageTTL. Best-effort by design:
// a directory we cannot read, or a file another process removed underneath
// us, is not a reason to refuse a rewrite the user is waiting for.
func (s *fileStager) prune(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		s.log.Debug("shellintegration: could not read staging dir to prune", "dir", dir, "error", err)
		return
	}
	cutoff := time.Now().Add(-stageTTL)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, ierr := e.Info()
		if ierr != nil || info.ModTime().After(cutoff) {
			continue
		}
		if rerr := os.Remove(filepath.Join(dir, e.Name())); rerr != nil {
			s.log.Debug("shellintegration: could not prune staged launcher", "name", e.Name(), "error", rerr)
		}
	}
}
