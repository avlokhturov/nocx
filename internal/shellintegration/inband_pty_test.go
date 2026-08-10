//go:build linux

// The in-band PTY bootstrap suite is Linux-only by design (nocx-gd84
// follow-up): the fixture seeds the pty's Cflag with the 0xF0000 bits that
// make GNU stty's encoding roundtrip — those bits are Linux termios
// semantics. On darwin the same bits are flow-control flags (CCTS_OFLOW,
// CRTS_IFLOW, CDSR_OFLOW, CDTR_IFLOW), so running the suite there would
// assert Linux encodings and could enable flow control on the test pty. The
// launcher and scripts suites (no termios seeding) cover the same real
// shells cross-platform; this suite is the Linux-depth layer.
package shellintegration

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// In-band integration pty tests: they drive the REAL wrapper line and payload
// into a REAL interactive shell on a REAL pty, and assert the fences
// (spec §4.4, ADR-0004):
//
//   - the exact prior termios is restored after a successful integration;
//   - the exact prior termios is restored on cancel (terminator sent, no
//     payload);
//   - a failure leaves an ordinary terminal with a visible native prompt
//     (fail-open is absolute);
//   - the shell at the prompt is never shown the payload bytes (raw mode
//     before delivery, READY handshake);
//   - the payload works for bash, zsh and POSIX sh (the dispatcher detects
//     the shell from inside it).
//
// These tests type into a shell the way the frontend would, so they exercise
// the wrapper's own save/restore rather than trusting its text.

const inBandTestPrompt = "IBPROMPT> "

// ptySession owns a shell on a pty. ONE pump goroutine is the only reader:
// abandoned per-read goroutines would consume output and corrupt every
// subsequent observation, so reads are never abandoned here.
type ptySession struct {
	t    *testing.T
	ptmx *os.File
	mu   sync.Mutex
	buf  strings.Builder
}

// #nosec G204 — `path` is a requireShell-resolved binary (LookPath + skip);
// driving the real wrapper line into a real interactive shell on a real pty
// is the only way to observe the save/restore fence (same annotation as
// runLauncherOnPTY).
func startSession(t *testing.T, shell string, extraEnv ...string) *ptySession {
	t.Helper()
	path := requireShell(t, shell)
	home := t.TempDir()
	rc := "PS1='" + inBandTestPrompt + "'\n"
	env := cleanEnv(
		"HOME="+home,
		"TMPDIR="+t.TempDir(),
		"TERM=xterm",
		"HISTFILE=/dev/null", // no history file in the disposable HOME at exit
	)
	switch shell {
	case "bash":
		if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte(rc), 0o600); err != nil {
			t.Fatalf("write .bashrc: %v", err)
		}
	case "zsh":
		zdot := t.TempDir()
		if err := os.WriteFile(filepath.Join(zdot, ".zshrc"), []byte(rc), 0o600); err != nil {
			t.Fatalf("write .zshrc: %v", err)
		}
		env = append(env, "ZDOTDIR="+zdot)
	case "dash":
		// Interactive dash sources $ENV (POSIX) — the one rc it will read
		// without a login shell. Without it the prompt is the default "$ ".
		envFile := filepath.Join(t.TempDir(), "dashrc")
		if err := os.WriteFile(envFile, []byte(rc), 0o600); err != nil {
			t.Fatalf("write dash ENV: %v", err)
		}
		env = append(env, "ENV="+envFile)
	}
	env = append(env, extraEnv...)
	cmd := exec.Command(path, "-i")
	cmd.Env = env
	// Open the pty explicitly (instead of pty.Start) so the fixture can seed
	// the slave's termios BEFORE the child exists. pty.Start's child inherits
	// the slave, immediately takes it as its controlling terminal, and races
	// the parent's first termios write; when the child wins, the shell's
	// captured terminal state lacks the seeded bits and its next termios
	// write restores the kernel default over the seed — an intermittent
	// before==after failure (measured ~1 in 7 full-suite runs in the
	// pre-commit container, 2026-08-04). Seeding the already-open slave fd
	// before cmd.Start is deterministic: no shell component exists yet, so
	// every capture sees the canonical encoding and the checks below test
	// the wrapper's restore, not a race.
	ptmx, tty, err := pty.Open()
	if err != nil {
		t.Fatalf("pty open %s: %v", shell, err)
	}
	// The kernel's fresh pty Cflag (0xBF: output-baud bits only) is an
	// encoding GNU stty cannot represent: `stty -g` renders it as 0xF00BF
	// (input-baud high bits set; stty -a shows the same 38400 baud both
	// ways), so a bare `stty -g; stty "$saved"` maps 0xBF -> 0xF00BF.
	// Seed the fixture to the canonical encoding stty actually roundtrips,
	// so the bit-exact before==after checks test the wrapper's restore, not
	// the kernel encoding artifact. dash exercises this directly (no
	// readline to mask it); bash/zsh would hide it by rewriting termios at
	// their prompt.
	ts, err := unix.IoctlGetTermios(int(tty.Fd()), unix.TCGETS)
	if err != nil {
		t.Fatalf("seed termios TCGETS: %v", err)
	}
	ts.Cflag |= 0xF0000
	if err := unix.IoctlSetTermios(int(tty.Fd()), unix.TCSETS, ts); err != nil {
		t.Fatalf("seed termios TCSETS: %v", err)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, tty, tty
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}
	if err := cmd.Start(); err != nil {
		_ = ptmx.Close()
		_ = tty.Close()
		t.Fatalf("pty start %s: %v", shell, err)
	}
	// The child holds the slave through its stdio fds; closing the parent's
	// copy here mirrors pty.Start (the pty stays alive while the child lives).
	_ = tty.Close()
	s := &ptySession{t: t, ptmx: ptmx}
	go s.pump()
	t.Cleanup(func() { _ = ptmx.Close() })
	return s
}

// pump is the single reader: everything the shell writes lands in s.buf.
func (s *ptySession) pump() {
	buf := make([]byte, 8192)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			s.mu.Lock()
			s.buf.Write(buf[:n])
			s.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// snapshot returns everything read so far.
func (s *ptySession) snapshot() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// waitFor blocks until substr appears in the accumulated output or the
// timeout elapses, then fails the test.
func (s *ptySession) waitFor(substr string, timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if strings.Contains(s.snapshot(), substr) {
			return
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("timed out waiting for %q; output so far: %q", substr, s.snapshot())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// type lets the shell answer a command; fails if the answer does not come.
func (s *ptySession) typeAndWait(line, expected string, timeout time.Duration) {
	s.t.Helper()
	if _, err := s.ptmx.Write([]byte(line)); err != nil {
		s.t.Fatalf("write %q: %v", line, err)
	}
	s.waitFor(expected, timeout)
}

// assertNoIntegrationMarkers fails if any OSC 133/636 marker appeared in the
// accumulated output — an unintegrated shell must not emit them.
func (s *ptySession) assertNoIntegrationMarkers() {
	s.t.Helper()
	time.Sleep(400 * time.Millisecond)
	got := s.snapshot()
	for _, marker := range []string{"\x1b]133;", "\x1b]636;"} {
		if strings.Contains(got, marker) {
			s.t.Errorf("unexpected integration marker %q in %q", marker, got)
		}
	}
}

// assertNoPayloadLeak fails if any hook-script source text appears in the
// visible transcript. The delivery window runs with `stty raw -echo` (GNU
// coreutils raw alone leaves ECHO set), so the ~25 KB payload is typed into a
// terminal that is provably not echoing — the user sees the wrapper line and
// the integration result, never the staged script.
func (s *ptySession) assertNoPayloadLeak() {
	s.t.Helper()
	visible := stripOsc(s.snapshot())
	for _, leaked := range []string{"__nocx_precmd() {", "__nocx_prompt_command() {", "NOCX_IB_BASH_START"} {
		if strings.Contains(visible, leaked) {
			s.t.Errorf("payload byte leaked into the visible transcript (%q): %q", leaked, visible)
		}
	}
}

// assertEchoOff fails if ECHO is still set in the given termios. Anchored at
// READY arrival: the wrapper emitted READY only after `stty raw -echo`, so
// ECHO off here proves the window is silent before any payload byte goes
// out (GNU coreutils `stty raw` alone leaves ECHO set — Lflag 0x8A38).
func (s *ptySession) assertEchoOff(ts unix.Termios) {
	s.t.Helper()
	if ts.Lflag&unix.ECHO != 0 {
		s.t.Errorf("ECHO still set inside the delivery window: Lflag %#x", ts.Lflag)
	}
}

// assertEchoOn fails if ECHO is not set in the given termios. Anchored at the
// integration hello (OSC 636 ; H): the sourced hooks emit it INSIDE the
// wrapper, AFTER the `stty "$saved"` restore and before any user code or
// readline re-prep runs. ECHO on there is the "the user can see themselves
// typing" proof — the restore completed before the hooks ran. (At the prompt
// itself readline legitimately runs with tty ECHO off and echoes itself, so
// the prompt is not the right sampling point.)
func (s *ptySession) assertEchoOn(ts unix.Termios) {
	s.t.Helper()
	if ts.Lflag&unix.ECHO == 0 {
		s.t.Errorf("ECHO not restored before the hooks ran: Lflag %#x", ts.Lflag)
	}
}

// assertEchoUnchanged fails if the ECHO bit differs from the pre-window
// state. Used on the cancel and fail-open paths, where the window ends at
// the shell prompt: readline legitimately runs with tty ECHO off (it echoes
// itself), so the invariant is "echo behaviour exactly as it was before",
// not "ECHO on". The bit-exact before==after check remains the primary
// assertion; this names the echo half of it.
func (s *ptySession) assertEchoUnchanged(before, after unix.Termios) {
	s.t.Helper()
	if before.Lflag&unix.ECHO != after.Lflag&unix.ECHO {
		s.t.Errorf("ECHO state changed across the window: before %#x after %#x", before.Lflag, after.Lflag)
	}
}

// termiosOf reads the slave's termios through the master.
func (s *ptySession) termios() unix.Termios {
	s.t.Helper()
	ts, err := unix.IoctlGetTermios(int(s.ptmx.Fd()), unix.TCGETS)
	if err != nil {
		s.t.Fatalf("TCGETS: %v", err)
	}
	return *ts
}

// settleUntilReadline waits (bounded) until the shell is idle at its prompt
// again — readline re-entered its own termios mode. The A marker fires from
// PROMPT_COMMAND BEFORE readline preps, so an immediate capture would race
// the shell's mode change and misreport the wrapper's restore.
func (s *ptySession) settleUntilReadline(want unix.Termios, timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		ts := s.termios()
		if ts.Iflag == want.Iflag && ts.Lflag == want.Lflag && ts.Cflag == want.Cflag {
			return
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("shell did not return to the prompt termios: got %+v want %+v", ts, want)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// waitForPromptAgain waits until the visible native prompt has appeared at
// least twice — the shell left the wrapper and is back at readline.
func (s *ptySession) waitForPromptAgain(timeout time.Duration) {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if strings.Count(s.snapshot(), inBandTestPrompt) >= 2 {
			return
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("native prompt did not return; output so far: %q", s.snapshot())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// cleanEnv strips NOCX_* and __nocx_* variables so the test shell starts
// unintegrated — the far end of a plain `ssh somehost`.
func cleanEnv(extra ...string) []string {
	var env []string
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "NOCX_") || strings.HasPrefix(e, "__nocx_") {
			continue
		}
		env = append(env, e)
	}
	return append(env, extra...)
}

// plan builds the in-band plan for the test.
func plan(t *testing.T, sid string) InBandPlan {
	t.Helper()
	p, err := New(nil).InBandBootstrap(sid, nil)
	if err != nil {
		t.Fatalf("InBandBootstrap: %v", err)
	}
	return p
}

// TestInBandBootstrap_RealBashIntegratesAndRestores is the happy path: a
// plain interactive bash at its native prompt, the wrapper line typed, READY
// received, the payload streamed, and the shell comes up integrated — with
// the EXACT prior termios restored.
func TestInBandBootstrap_RealBashIntegratesAndRestores(t *testing.T) {
	s := startSession(t, "bash")
	s.waitFor(inBandTestPrompt, 15*time.Second)
	before := s.termios()

	p := plan(t, "0123456789abcdef0123456789abcdef")
	s.typeAndWait(p.Wrapper+"\r", "\x1b]1337;NOCX_IB_READY\x07", 15*time.Second)
	// READY arrives only after `stty raw -echo`: the window is provably
	// silent before any payload byte goes out.
	s.assertEchoOff(s.termios())
	s.typeAndWait(p.Payload+p.Terminator+"\n", "\x1b]636;H;", 15*time.Second)
	// The 636 hello is emitted INSIDE the wrapper, after the exact restore
	// and before any user code or readline re-prep runs: echo is back on.
	s.assertEchoOn(s.termios())
	s.waitFor("\x1b]133;A", 15*time.Second)
	// The A marker fires from PROMPT_COMMAND BEFORE readline re-enters its
	// own termios mode; an immediate capture would race the mode change and
	// misreport the wrapper's restore. Wait for readline's mode to return.
	s.settleUntilReadline(before, 5*time.Second)
	after := s.termios()
	if before != after {
		s.t.Errorf("termios not restored exactly: before %+v after %+v", before, after)
	}
	s.assertEchoUnchanged(before, after)
	// The payload bytes must never be echoed: the visible transcript carries
	// the wrapper line's echo but no hook-script source text.
	s.assertNoPayloadLeak()

	// The shell is usable afterwards.
	s.typeAndWait("echo INTEGRATED_OK\r", "INTEGRATED_OK", 15*time.Second)
	_, _ = s.ptmx.Write([]byte("exit\r"))
}

// TestInBandBootstrap_RealBashCancelRestores is the Esc-cancel path: the
// frontend sends the terminator instead of the payload; sed quits, the
// wrapper restores the exact termios, and the shell stays an ORDINARY
// terminal with a visible native prompt and no integration markers.
func TestInBandBootstrap_RealBashCancelRestores(t *testing.T) {
	s := startSession(t, "bash")
	s.waitFor(inBandTestPrompt, 15*time.Second)
	before := s.termios()

	p := plan(t, "0123456789abcdef0123456789abcdef")
	s.typeAndWait(p.Wrapper+"\r", "\x1b]1337;NOCX_IB_READY\x07", 15*time.Second)
	// The window was entered: READY proves raw -echo is on, so the payload
	// would have been delivered silently.
	s.assertEchoOff(s.termios())
	// Cancel: the terminator alone. The staged file holds nothing with the
	// completion marker, so nothing is sourced; the native prompt returns.
	if _, err := s.ptmx.Write([]byte("\n" + p.Terminator + "\n")); err != nil {
		s.t.Fatalf("write terminator: %v", err)
	}
	s.waitForPromptAgain(15 * time.Second)
	s.typeAndWait("echo CANCEL_OK\r", "CANCEL_OK", 15*time.Second)
	s.assertNoIntegrationMarkers()
	after := s.termios()
	if before != after {
		s.t.Errorf("termios not restored after cancel: before %+v after %+v", before, after)
	}
	s.assertEchoUnchanged(before, after)
	_, _ = s.ptmx.Write([]byte("exit\r"))
}

// TestInBandBootstrap_RealBashFailOpen drives the no-mktemp failure: the
// wrapper cannot enter raw mode, the chain stops before any byte is
// delivered, and the shell is left an ordinary terminal with its termios
// untouched.
func TestInBandBootstrap_RealBashFailOpen(t *testing.T) {
	s := startSession(t, "bash", "PATH=/nonexistent")
	s.waitFor(inBandTestPrompt, 15*time.Second)
	before := s.termios()

	p := plan(t, "0123456789abcdef0123456789abcdef")
	// Nothing can run (mktemp/stty/sed are not on PATH): the shell must come
	// straight back to a visible prompt.
	if _, err := s.ptmx.Write([]byte(p.Wrapper + "\r")); err != nil {
		s.t.Fatalf("write wrapper: %v", err)
	}
	s.waitForPromptAgain(15 * time.Second)
	s.assertNoIntegrationMarkers()
	after := s.termios()
	if before != after {
		s.t.Errorf("termios changed on the failure path: before %+v after %+v", before, after)
	}
	s.assertEchoUnchanged(before, after)
	s.typeAndWait("echo FAILOPEN_OK\r", "FAILOPEN_OK", 15*time.Second)
	_, _ = s.ptmx.Write([]byte("exit\r"))
}

// missingMktempPath builds a PATH whose staging applets (stty, grep, rm, sed)
// all resolve, but mktemp is genuinely absent — the minimal-applet box this
// wrapper is built for (nocx-pu4.3). The wrapper must fail open: the staging
// chain short-circuits before raw mode, no READY fires, and the shell comes
// straight back to a usable prompt instead of hanging on the delivery window.
func missingMktempPath(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, bin := range []string{"stty", "grep", "rm", "sed"} {
		path, err := exec.LookPath(bin)
		if err != nil {
			t.Skipf("%s not installed: %v", bin, err)
		}
		if err := os.Symlink(path, filepath.Join(dir, bin)); err != nil {
			t.Fatalf("symlink %s: %v", bin, err)
		}
	}
	if _, err := exec.LookPath("mktemp"); err != nil {
		t.Skipf("mktemp not installed: cannot construct a PATH without it")
	}
	return dir
}

// TestInBandBootstrap_RealBashFailOpenMissingApplet drives the one-applet
// failure: mktemp absent while every other staging applet works. The wrapper
// must fail open to an ordinary terminal — prompt back, termios untouched, no
// integration markers, shell usable — the "never a 15-second freeze on
// somebody's terminal" half of nocx-pu4.3.
func TestInBandBootstrap_RealBashFailOpenMissingApplet(t *testing.T) {
	s := startSession(t, "bash", "PATH="+missingMktempPath(t))
	s.waitFor(inBandTestPrompt, 15*time.Second)
	before := s.termios()

	p := plan(t, "0123456789abcdef0123456789abcdef")
	if _, err := s.ptmx.Write([]byte(p.Wrapper + "\r")); err != nil {
		t.Fatalf("write wrapper: %v", err)
	}
	s.waitForPromptAgain(15 * time.Second)
	s.assertNoIntegrationMarkers()
	after := s.termios()
	if before != after {
		t.Errorf("termios changed on the missing-applet path: before %+v after %+v", before, after)
	}
	s.assertEchoUnchanged(before, after)
	s.typeAndWait("echo FAILOPEN_APPLET_OK\r", "FAILOPEN_APPLET_OK", 15*time.Second)
	_, _ = s.ptmx.Write([]byte("exit\r"))
}

// TestInBandBootstrap_RealZshIntegratesAndRestores runs the same happy path
// under zsh: the wrapper is shell-agnostic, and the dispatcher must select
// the zsh hooks.
func TestInBandBootstrap_RealZshIntegratesAndRestores(t *testing.T) {
	s := startSession(t, "zsh")
	s.waitFor(inBandTestPrompt, 15*time.Second)
	before := s.termios()

	p := plan(t, "0123456789abcdef0123456789abcdef")
	s.typeAndWait(p.Wrapper+"\r", "\x1b]1337;NOCX_IB_READY\x07", 15*time.Second)
	s.assertEchoOff(s.termios())
	s.typeAndWait(p.Payload+p.Terminator+"\n", "\x1b]133;A", 15*time.Second)
	// zsh has no source-time emission to anchor the restore boundary on: its
	// A marker fires from precmd AFTER zle has already taken the terminal
	// (measured: Lflag 0x8a31, zle's editing mode, ECHO off by design). The
	// restore itself is the shared wrapper text proven by the bash 636 hello
	// anchor; here the bit-exact before==after below is the assertion.
	s.settleUntilReadline(before, 5*time.Second)
	after := s.termios()
	if before != after {
		s.t.Errorf("termios not restored exactly (zsh): before %+v after %+v", before, after)
	}
	s.assertEchoUnchanged(before, after)
	s.assertNoPayloadLeak()
	s.typeAndWait("echo ZSH_OK\r", "ZSH_OK", 15*time.Second)
	_, _ = s.ptmx.Write([]byte("exit\r"))
}

// TestInBandBootstrap_RealDashIntegratesAndRestores runs the happy path under
// dash — the POSIX-sh tier (spec §6): the wrapper is POSIX, the dispatcher
// must select the posix hooks, and the A marker arrives from PS1 expansion.
func TestInBandBootstrap_RealDashIntegratesAndRestores(t *testing.T) {
	s := startSession(t, "dash")
	s.waitFor(inBandTestPrompt, 15*time.Second)
	before := s.termios()

	p := plan(t, "0123456789abcdef0123456789abcdef")
	s.typeAndWait(p.Wrapper+"\r", "\x1b]1337;NOCX_IB_READY\x07", 15*time.Second)
	s.assertEchoOff(s.termios())
	s.typeAndWait(p.Payload+p.Terminator+"\n", "\x1b]133;A", 15*time.Second)
	// dash does no termios gymnastics of its own; the A marker arrives from
	// PS1 expansion with the wrapper's restored state in effect — echo on.
	s.assertEchoOn(s.termios())
	s.settleUntilReadline(before, 5*time.Second)
	after := s.termios()
	if before != after {
		s.t.Errorf("termios not restored exactly (dash): before %+v after %+v", before, after)
	}
	s.assertEchoUnchanged(before, after)
	s.assertNoPayloadLeak()
	s.typeAndWait("echo DASH_OK\r", "DASH_OK", 15*time.Second)
	_, _ = s.ptmx.Write([]byte("exit\r"))
}

var _ = fmt.Sprintf
