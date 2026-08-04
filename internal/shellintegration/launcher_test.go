package shellintegration

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
)

// writeBashFixtureHome materialises a fixture $HOME whose .bashrc sets a
// sentinel, prints a marker, and points HISTFILE at /dev/null — the last so
// an ordinary exit-time history write cannot disturb the no-$HOME-writes
// invariant, isolating the launcher's own behaviour.
func writeBashFixtureHome(t *testing.T, extra string) string {
	t.Helper()
	home := t.TempDir()
	rc := `export NOCX_LAUNCHER_SENTINEL=from-user-rc
HISTFILE=/dev/null
PS1='FIXTURE-PROMPT> '
echo USER_RC_RAN
` + extra
	if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte(rc), 0o600); err != nil {
		t.Fatalf("write fixture .bashrc: %v", err)
	}
	return home
}

// requireBinBash skips the test only when the host has no bash at all. The
// launcher resolves bash through `env`, on PATH, rather than naming
// /bin/bash absolutely — an absolute path skipped this test on every NixOS
// and Guix host, which is to say it skipped the epic's primary path on the
// machine it was developed on.
func requireBinBash(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skipf("bash not present on this host: %v", err)
	}
}

// requireIntegrationShell fails the test when the shell is absent instead of
// skipping. Skipping is how the launcher's riskiest path — the zsh
// transient-ZDOTDIR lifecycle, which creates a directory on somebody else's
// machine and must erase it before any user code runs — reported green on
// every box without zsh. That is the silent success AGENTS.md's testing rules
// exist to prevent (nocx-gd84): the suite must say "this did not run", never
// pretend it did.
//
// The provisioning command is what CI runs the suite with: ubuntu-latest
// ships both dash and zsh, macOS ships zsh but not dash, so the macOS CI
// job must install dash itself (see README, "Shell integration tests").
//
//	# Debian/Ubuntu (dash and zsh)
//	sudo apt-get install -y dash zsh
//	# macOS (zsh ships with the OS)
//	brew install dash
//
// then run the suite the way CI does:
//
//	go test -race -count=1 ./internal/shellintegration/...
func requireIntegrationShell(t *testing.T, shell string) string {
	t.Helper()
	path, err := exec.LookPath(shell)
	if err == nil {
		return path
	}
	t.Fatalf("%s is required by this test and missing from PATH (%v).\n"+
		"The launcher's riskiest paths must not silently skip.\n"+
		"Provision the shells CI runs the suite with, then re-run:\n"+
		"  Debian/Ubuntu: sudo apt-get install -y dash zsh\n"+
		"  macOS:         brew install dash   (zsh ships with the OS)\n"+
		"  then:          go test -race -count=1 ./internal/shellintegration/...",
		shell, err)
	return ""
}

// writeZshFixtureHome materialises a fixture $HOME whose .zshrc sets a
// sentinel, prints a marker, and reports whether the launcher's transient
// directory still exists at the moment the user's rc runs.
func writeZshFixtureHome(t *testing.T, extra string) string {
	t.Helper()
	home := t.TempDir()
	rc := `export NOCX_LAUNCHER_SENTINEL=from-user-rc
echo USER_RC_RAN
if ls -d "${TMPDIR:-/tmp}"/nocx-zsh.* >/dev/null 2>&1; then echo TRANSIENT_PRESENT; else echo TRANSIENT_GONE; fi
` + extra
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte(rc), 0o600); err != nil {
		t.Fatalf("write fixture .zshrc: %v", err)
	}
	return home
}

// runLauncherOnPTY executes `shPath -c cmd` — shPath standing in for the
// login shell sshd hands a remote command to — on a real pty, waits for the
// first prompt, types each line, then waits for the session to end. It
// returns all captured output. Write failures after the session ended on
// its own (an early exit in a fixture rc) are benign and logged.
//
// #nosec G204 — shPath is a requireShell-resolved binary and cmd is a
// launcher string built from package constants; a pty is the only way to
// observe prompt-time behaviour.
func runLauncherOnPTY(t *testing.T, shPath, cmd string, env []string, lines ...string) string {
	t.Helper()
	c := exec.Command(shPath, "-c", cmd)
	c.Env = append(os.Environ(), env...)
	ptmx, err := pty.Start(c)
	if err != nil {
		t.Fatalf("pty start: %v", err)
	}
	defer func() { _ = ptmx.Close() }()

	done := make(chan []byte, 1)
	go func() {
		out, _ := io.ReadAll(ptmx)
		done <- out
	}()

	// The bash launcher's first prompt can wait up to 250 ms for the
	// source-time snapshot job; give both shells room to settle.
	time.Sleep(600 * time.Millisecond)
	for _, line := range lines {
		if _, werr := ptmx.Write([]byte(line + "\n")); werr != nil {
			t.Logf("write %q failed (session may have exited early): %v", line, werr)
		}
		time.Sleep(400 * time.Millisecond)
	}

	var out []byte
	select {
	case out = <-done:
	case <-time.After(20 * time.Second):
		_ = c.Process.Kill()
		t.Fatal("timed out waiting for the session to end")
	}
	if werr := c.Wait(); werr != nil {
		t.Logf("session exited non-zero (may be benign): %v", werr)
	}
	return string(out)
}

// TestShellUnknownGetsPosixTier pins the deliberate decision (nocx-518d):
// ShellUnknown is the minimal tier, not a refusal — spec §6 names dash /
// busybox ash / POSIX sh as a real, verified tier, and refusing them
// forever would contradict D4. The posix command is POSIX-only (parsed by
// an explicit /bin/sh, execs ${SHELL:-/bin/sh}), so an unknown shell that
// ignores ENV still gets a plain shell — the refusal outcome, minus the
// refusal.
func TestShellUnknownGetsPosixTier(t *testing.T) {
	cmd, reason, ok := NewRemoteLauncher().StartCommand(ShellUnknown, LaunchOptions{})
	if !ok {
		t.Fatalf("ShellUnknown refused: reason=%q", reason)
	}
	if reason != ReasonNone {
		t.Errorf("reason = %q, want none", reason)
	}
	if !strings.Contains(cmd, "/bin/sh -c ") {
		t.Errorf("posix command does not run through an explicit /bin/sh: %q", cmd)
	}
	if !strings.Contains(cmd, "nocx-posix") {
		t.Errorf("posix command missing transient dir marker: %q", cmd)
	}
	// The exec target is ${SHELL:-/bin/sh}, never a named bash/zsh binary —
	// the far shell is unknown by definition, and the payload must stay
	// POSIX-only (the embedded script's prose mentions bash/zsh, so a raw
	// substring check on the whole command would be noise).
	if strings.Contains(cmd, `exec bash`) || strings.Contains(cmd, `exec zsh`) {
		t.Errorf("posix command must never exec a named bash/zsh binary: %q", cmd)
	}
	if !strings.Contains(cmd, `exec "${SHELL:-/bin/sh}" -l`) {
		t.Errorf("posix command does not exec the login shell via ${SHELL:-/bin/sh}: %q", cmd)
	}
}

// TestUnmappedShellKindRefused is the default-arm tripwire: a ShellKind that
// has no launcher must refuse loudly rather than silently get the posix
// tier — a new kind is a decision, not a fallback.
func TestUnmappedShellKindRefused(t *testing.T) {
	cmd, reason, ok := NewRemoteLauncher().StartCommand(ShellKind("fish"), LaunchOptions{})
	if ok {
		t.Fatalf("unmapped kind accepted; got command %q", cmd)
	}
	if reason != ReasonUnsupportedShell {
		t.Errorf("reason = %q, want %q", reason, ReasonUnsupportedShell)
	}
	if cmd != "" {
		t.Errorf("command = %q, want empty", cmd)
	}
}

// TestEnhancedRequiresSessionID pins the pinned precondition "never empty
// when Enhanced": the launcher fails closed rather than emit a marker-only
// session the ownership protocol cannot anchor.
func TestEnhancedRequiresSessionID(t *testing.T) {
	for _, kind := range []ShellKind{ShellBash, ShellZsh, ShellUnknown} {
		cmd, reason, ok := NewRemoteLauncher().StartCommand(kind, LaunchOptions{Enhanced: true})
		if ok {
			t.Errorf("%s: enhanced with empty SessionID accepted; got %q", kind, cmd)
		}
		if reason != ReasonUnsupportedShell {
			t.Errorf("%s: reason = %q, want unsupported-shell", kind, reason)
		}
	}
}

// TestLauncherCommandsHaveNoNul: the payload must contain no NUL (spec §4.1)
// — a NUL would corrupt the rcfile stream.
func TestLauncherCommandsHaveNoNul(t *testing.T) {
	l := NewRemoteLauncher()
	for _, kind := range []ShellKind{ShellBash, ShellZsh, ShellUnknown} {
		cmd, _, ok := l.StartCommand(kind, LaunchOptions{Enhanced: true, SessionID: "abcdef0123456789"})
		if !ok {
			t.Fatalf("%s: refused", kind)
		}
		if strings.ContainsRune(cmd, 0) {
			t.Errorf("%s: command contains a NUL byte", kind)
		}
	}
}

// TestLauncherCommandsUnderCap: both launchers sit well below the chosen
// conservative ARG_MAX bound (see maxLauncherLen).
func TestLauncherCommandsUnderCap(t *testing.T) {
	l := NewRemoteLauncher()
	for _, kind := range []ShellKind{ShellBash, ShellZsh, ShellUnknown} {
		cmd, _, ok := l.StartCommand(kind, LaunchOptions{Enhanced: true, SessionID: "abcdef0123456789"})
		if !ok {
			t.Fatalf("%s: refused", kind)
		}
		if len(cmd) > maxLauncherLen {
			t.Errorf("%s: command is %d bytes, cap is %d", kind, len(cmd), maxLauncherLen)
		}
	}
}

// TestLauncherRefusesOverCap lowers the cap to prove the refusal path: a
// launcher that would outgrow the remote ARG_MAX must refuse, not emit a
// command the far host cannot exec.
func TestLauncherRefusesOverCap(t *testing.T) {
	old := maxLauncherLen
	maxLauncherLen = 64
	t.Cleanup(func() { maxLauncherLen = old })

	l := NewRemoteLauncher()
	for _, kind := range []ShellKind{ShellBash, ShellZsh, ShellUnknown} {
		cmd, reason, ok := l.StartCommand(kind, LaunchOptions{Enhanced: true, SessionID: "abcdef0123456789"})
		if ok {
			t.Errorf("%s: over-cap command accepted (%d bytes)", kind, len(cmd))
		}
		if reason != ReasonUnsupportedShell || cmd != "" {
			t.Errorf("%s: reason=%q cmd=%q, want unsupported-shell and empty", kind, reason, cmd)
		}
	}
}

// TestPrintfBEscapeRoundTripsThroughBashBuiltin drives the real bash
// builtin printf — the exact decoder the launcher ships its rcfile through
// — over a payload holding every byte class the escaper must survive:
// quotes, dollars, backticks, backslashes, control bytes, octal-digit
// adjacency (`\n` followed by an octal digit must not bleed into the
// escape), and non-ASCII UTF-8.
func TestPrintfBEscapeRoundTripsThroughBashBuiltin(t *testing.T) {
	bash := requireShell(t, "bash")
	payload := "NOCX_SESSION_ID='abc'\n\"$`\\ \t\n\x00\x1b\r" +
		"1234567" + "\n" + "3" + "\n" + "7" + "\n" + "0" + "\u00e9\u4e2d"
	escaped := printfBEscape(payload)
	if strings.ContainsRune(escaped, '\'') {
		t.Errorf("escaped payload contains a literal single quote: %q", escaped)
	}
	// #nosec G204 — bash is requireShell-resolved; the escaped string is
	// generated by printfBEscape, which never emits quote characters.
	cmd := exec.Command(bash, "-c", `printf %b "`+escaped+`"`)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("bash printf: %v", err)
	}
	if string(out) != payload {
		t.Errorf("round trip mismatch:\n got %q\nwant %q", out, payload)
	}
}

// TestShellQuoteEscapesEmbeddedQuotes: the escaper is real, not
// concatenation that happens to work on today's payloads.
func TestShellQuoteEscapesEmbeddedQuotes(t *testing.T) {
	if got := shellQuote("a'b"); got != `'a'\''b'` {
		t.Errorf("shellQuote(a'b) = %q", got)
	}
	if got := shellQuote("plain"); got != "'plain'" {
		t.Errorf("shellQuote(plain) = %q", got)
	}
}

// TestBashLauncher_EmitsMarkersAndRunsUserRc drives the REAL bash launcher
// command end to end on a pty and asserts the acceptance surface: OSC 133 A
// and B markers arrive, the user's own ~/.bashrc ran (sentinel + marker),
// marker-only mode hides the fixture prompt, and $0 is "bash" (non-login).
func TestBashLauncher_EmitsMarkersAndRunsUserRc(t *testing.T) {
	requireShell(t, "bash")
	requireBinBash(t)
	home := writeBashFixtureHome(t, "")
	tmp := t.TempDir()
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellBash, LaunchOptions{Enhanced: true, SessionID: "test-session-1"})
	if !ok {
		t.Fatal("bash launcher refused")
	}

	out := runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"},
		`echo "SENTINEL=$NOCX_LAUNCHER_SENTINEL"; echo "ZERO=$0"`, "exit")

	ms := extractOscMarkers(out)
	if countMarkers(ms, "A") == 0 {
		t.Errorf("no OSC 133 A marker in output: %q", out)
	}
	if countMarkers(ms, "B") == 0 {
		t.Errorf("no OSC 133 B marker in output: %q", out)
	}
	if !strings.Contains(out, "USER_RC_RAN") {
		t.Errorf("the user's ~/.bashrc did not run: %q", out)
	}
	if !strings.Contains(out, "SENTINEL=from-user-rc") {
		t.Errorf("the user's rc sentinel did not survive: %q", out)
	}
	if !strings.Contains(out, "ZERO=bash") {
		t.Errorf("$0 = %q, want bash (non-login)", out)
	}
	if strings.Contains(out, "FIXTURE-PROMPT") {
		t.Errorf("marker-only mode left the fixture prompt visible: %q", out)
	}
}

// TestBashLauncher_BaselineKeepsVisiblePrompt: without Enhanced the prompt
// overlay is not armed; the fixture prompt stays visible and the B marker
// still wraps it.
func TestBashLauncher_BaselineKeepsVisiblePrompt(t *testing.T) {
	requireShell(t, "bash")
	requireBinBash(t)
	home := writeBashFixtureHome(t, "")
	tmp := t.TempDir()
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellBash, LaunchOptions{})
	if !ok {
		t.Fatal("bash launcher refused")
	}

	out := runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"}, "exit")

	ms := extractOscMarkers(out)
	if countMarkers(ms, "A") == 0 || countMarkers(ms, "B") == 0 {
		t.Errorf("baseline session missing markers: %q", out)
	}
	if !strings.Contains(out, "FIXTURE-PROMPT") {
		t.Errorf("baseline session hid the user's prompt: %q", out)
	}
}

// TestBashLauncher_NoHomeWrites compares a recursive listing of $HOME
// (names, sizes, mtimes) before and after a full bash session started by
// the launcher: nothing under $HOME may be created or modified. The
// fixture rc points HISTFILE at /dev/null so an ordinary exit-time history
// write cannot mask a launcher write.
func TestBashLauncher_NoHomeWrites(t *testing.T) {
	requireShell(t, "bash")
	requireBinBash(t)
	home := writeBashFixtureHome(t, "")
	tmp := t.TempDir()
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellBash, LaunchOptions{Enhanced: true, SessionID: "test-session-2"})
	if !ok {
		t.Fatal("bash launcher refused")
	}

	before := snapshotTree(t, home)
	out := runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"}, "echo hello", "exit")
	after := snapshotTree(t, home)

	if !equalSnapshots(before, after) {
		t.Errorf("$HOME changed during the launcher session (checked a recursive listing of names, sizes and mtimes before and after):\n before: %v\n after:  %v\noutput: %q", before, after, out)
	}
}

// TestBashLauncher_BashEnvNotExecuted: the outer `bash -c` must not execute
// BASH_ENV code (spec §4.3). A hostile BASH_ENV file that writes a marker
// under $HOME must never run.
func TestBashLauncher_BashEnvNotExecuted(t *testing.T) {
	requireShell(t, "bash")
	requireBinBash(t)
	home := writeBashFixtureHome(t, "")
	tmp := t.TempDir()
	envScript := filepath.Join(tmp, "bashenv.sh")
	if err := os.WriteFile(envScript, []byte("echo ran > \"$HOME/bashenv-ran\"\n"), 0o600); err != nil {
		t.Fatalf("write BASH_ENV script: %v", err)
	}
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellBash, LaunchOptions{Enhanced: true, SessionID: "test-session-3"})
	if !ok {
		t.Fatal("bash launcher refused")
	}

	out := runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm", "BASH_ENV=" + envScript}, "exit")

	if _, err := os.Stat(filepath.Join(home, "bashenv-ran")); !os.IsNotExist(err) {
		t.Errorf("BASH_ENV code executed in the outer bash -c (marker file exists): %v", err)
	}
	if strings.Contains(out, "bashenv-ran") {
		t.Errorf("BASH_ENV marker leaked into the session output: %q", out)
	}
}

// TestBashLauncher_UserRcExecPreventsInstall: user startup wins — a
// ~/.bashrc that execs a plain shell replaces the session, and nocx's
// hooks (which live after the source) never install.
func TestBashLauncher_UserRcExecPreventsInstall(t *testing.T) {
	requireShell(t, "bash")
	requireBinBash(t)
	home := writeBashFixtureHome(t, "exec bash --norc\n")
	tmp := t.TempDir()
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellBash, LaunchOptions{Enhanced: true, SessionID: "test-session-4"})
	if !ok {
		t.Fatal("bash launcher refused")
	}

	out := runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"}, "echo alive", "exit")

	ms := extractOscMarkers(out)
	if countMarkers(ms, "A") != 0 {
		t.Errorf("hooks installed despite the user's rc exec'ing: %q", out)
	}
	if !strings.Contains(out, "alive") {
		t.Errorf("the exec'd shell did not run: %q", out)
	}
}

// TestBashLauncher_RunsUnderDash: the pinned form's whole point — the
// remote command is parsed by the user's login shell, which may be dash.
// Parsing the same launcher with dash must work identically.
func TestBashLauncher_RunsUnderDash(t *testing.T) {
	dash := requireIntegrationShell(t, "dash")
	requireBinBash(t)
	home := writeBashFixtureHome(t, "")
	tmp := t.TempDir()
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellBash, LaunchOptions{Enhanced: true, SessionID: "test-session-5"})
	if !ok {
		t.Fatal("bash launcher refused")
	}

	out := runLauncherOnPTY(t, dash, cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"},
		`echo "SENTINEL=$NOCX_LAUNCHER_SENTINEL"`, "exit")

	ms := extractOscMarkers(out)
	if countMarkers(ms, "A") == 0 || countMarkers(ms, "B") == 0 {
		t.Errorf("dash-parsed launcher missing markers: %q", out)
	}
	if !strings.Contains(out, "SENTINEL=from-user-rc") {
		t.Errorf("user rc did not run under dash parsing: %q", out)
	}
}

// TestZshLauncher_TransientDirFlow drives the REAL zsh launcher on a pty
// and asserts: markers arrive, the user's real .zshrc ran, the transient
// directory is gone before the first user command, and nothing of it
// survives the session.
func TestZshLauncher_TransientDirFlow(t *testing.T) {
	requireIntegrationShell(t, "zsh")
	home := writeZshFixtureHome(t, "")
	tmp := t.TempDir()
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellZsh, LaunchOptions{Enhanced: true, SessionID: "test-session-6"})
	if !ok {
		t.Fatal("zsh launcher refused")
	}

	out := runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"},
		`echo "SENTINEL=$NOCX_LAUNCHER_SENTINEL"; echo "ZERO=$0"`, "exit")

	ms := extractOscMarkers(out)
	if countMarkers(ms, "A") == 0 {
		t.Errorf("no OSC 133 A marker: %q", out)
	}
	if countMarkers(ms, "B") == 0 {
		t.Errorf("no OSC 133 B marker: %q", out)
	}
	if !strings.Contains(out, "USER_RC_RAN") {
		t.Errorf("the user's .zshrc did not run: %q", out)
	}
	if !strings.Contains(out, "SENTINEL=from-user-rc") {
		t.Errorf("the user's rc sentinel did not survive: %q", out)
	}
	if !strings.Contains(out, "TRANSIENT_GONE") {
		t.Errorf("the transient dir still existed when the user's rc ran: %q", out)
	}
	if strings.Contains(out, "TRANSIENT_PRESENT") {
		t.Errorf("transient dir present at user-rc time: %q", out)
	}
	if !strings.Contains(out, "ZERO=zsh") {
		t.Errorf("$0 = %q, want zsh", out)
	}
	assertNoTransientDir(t, tmp)
}

// TestZshLauncher_CleanupAfterEarlyExit: a user .zshrc that exits early
// leaves no transient directory behind.
func TestZshLauncher_CleanupAfterEarlyExit(t *testing.T) {
	requireIntegrationShell(t, "zsh")
	home := writeZshFixtureHome(t, "exit 7\n")
	tmp := t.TempDir()
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellZsh, LaunchOptions{Enhanced: true, SessionID: "test-session-7"})
	if !ok {
		t.Fatal("zsh launcher refused")
	}

	runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"})
	assertNoTransientDir(t, tmp)
}

// TestZshLauncher_CleanupAfterSyntaxError: a user .zshrc that fails to
// parse (zsh reports and may or may not keep the shell alive) leaves no
// transient directory behind either way.
func TestZshLauncher_CleanupAfterSyntaxError(t *testing.T) {
	requireIntegrationShell(t, "zsh")
	home := writeZshFixtureHome(t, "if [[\n")
	tmp := t.TempDir()
	cmd, _, ok := NewRemoteLauncher().StartCommand(ShellZsh, LaunchOptions{Enhanced: true, SessionID: "test-session-8"})
	if !ok {
		t.Fatal("zsh launcher refused")
	}

	// The parse error may end the session immediately or leave the shell
	// at a prompt; send exit in either case (benign if already gone).
	runLauncherOnPTY(t, "/bin/sh", cmd,
		[]string{"HOME=" + home, "TMPDIR=" + tmp, "TERM=xterm"}, "exit")
	assertNoTransientDir(t, tmp)
}

// fileState is one entry of a $HOME snapshot.
type fileState struct {
	size int64
	mode os.FileMode
	mod  time.Time
}

// snapshotTree walks root and records every entry's name, size and mtime.
func snapshotTree(t *testing.T, root string) map[string]fileState {
	t.Helper()
	snap := map[string]fileState{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil {
			return rerr
		}
		snap[rel] = fileState{size: info.Size(), mode: info.Mode(), mod: info.ModTime()}
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot %s: %v", root, err)
	}
	return snap
}

func equalSnapshots(a, b map[string]fileState) bool {
	if len(a) != len(b) {
		return false
	}
	for k, va := range a {
		vb, ok := b[k]
		if !ok || va != vb {
			return false
		}
	}
	return true
}

// assertNoTransientDir fails unless no launcher transient directory
// remains under tmp.
func assertNoTransientDir(t *testing.T, tmp string) {
	t.Helper()
	left, err := filepath.Glob(filepath.Join(tmp, "nocx-zsh.*"))
	if err != nil {
		t.Fatalf("glob transient dirs: %v", err)
	}
	if len(left) != 0 {
		t.Errorf("transient directories survived the session: %v", left)
	}
}
