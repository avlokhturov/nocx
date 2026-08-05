package shellintegration

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
)

// The whole arc of nocx-pu4.6, watched end to end on a real pty (AGENTS.md
// testing rule 2): a user types `ssh user@host` in an integrated local tab,
// the line the renderer rewrites goes into a REAL interactive bash through a
// REAL terminal, and the remote host comes up integrated from its first
// prompt.
//
// Everything between is real. The launcher is the product's, built by
// NewRemoteLauncher and staged by the production stager. The line is the
// shape frontend/src/ssh-transition.ts builds (its exact text is pinned by
// the vitest suite; this test asserts the behaviour that shape must have).
// `ssh` is a stub — the only stub — and it stands in for sshd the way sshd
// actually behaves: it takes the last argument as the remote command and
// hands it to the login shell as `$SHELL -c <command>` with argv[0] set to
// the shell, which is exactly what the auto dispatcher reads `"$0"` from.
//
// This is the test the reopened bead needed and did not have. Every unit
// was green while the product was broken, because nothing had ever put the
// rewritten line through a terminal: 35 KB went in, 27873 bytes came out,
// and the shell executed the fragments of a truncated script.

// ptyPrompt is the local shell's prompt in these tests: a sentinel that
// cannot occur in the launcher or in bash's own output.
const ptyPrompt = "LOCALPROMPT> "

// buildRewrittenLine reproduces the line frontend/src/ssh-transition.ts
// builds for a hand-typed ssh. The shape is DUPLICATED on purpose and the
// duplication is the point of the test: the renderer's own suite pins the
// string, and this one proves a line of that shape actually works when a
// terminal, a shell and a launcher are all real. If the two ever drift, the
// arc below is what stops being true.
func buildRewrittenLine(original, quotedPath string) string {
	return fmt.Sprintf(
		`if [ -s %s ]; then ssh -t %s "$(cat %s)"; else %s; fi`,
		quotedPath, strings.TrimPrefix(original, "ssh "), quotedPath, original,
	)
}

// writeFakeSSH installs an `ssh` on PATH that behaves the way sshd does with
// a remote command: it records the command it was given, then execs the
// login shell with argv[0] set to the shell's own path — the ground truth
// the dispatcher reads `"$0"` from (launcher_auto.go). `exec -a` is why this
// stub is bash: no POSIX sh can set argv[0].
func writeFakeSSH(t *testing.T, dir, argvOut string) {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skipf("bash not installed: %v", err)
	}
	stub := "#!" + bash + `
# Stand-in for ssh(1) + sshd: the remote command is the last argument.
cmd="${!#}"
printf '%s' "$cmd" > "` + argvOut + `"
exec -a ` + bash + ` ` + bash + ` -c "$cmd"
`
	path := filepath.Join(dir, "ssh")
	// A stub on PATH has to be executable; 0600 would make the shell report
	// "permission denied" instead of running it.
	// #nosec G306 -- an executable test fixture in a t.TempDir().
	if werr := os.WriteFile(path, []byte(stub), 0o700); werr != nil {
		t.Fatalf("write fake ssh: %v", werr)
	}
}

// TestHandTypedSSHRidesTheLauncherThroughARealTTY is the epic's happy path.
func TestHandTypedSSHRidesTheLauncherThroughARealTTY(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skipf("bash not installed: %v", err)
	}

	home := t.TempDir()
	bin := t.TempDir()
	argvOut := filepath.Join(t.TempDir(), "remote-command")
	writeFakeSSH(t, bin, argvOut)

	// The product's launcher, staged by the product's stager.
	launcher, _, ok := NewRemoteLauncher().StartCommand(ShellAuto, LaunchOptions{
		SessionID: "0123456789abcdef0123456789abcdef",
		Enhanced:  true,
	})
	if !ok {
		t.Fatal("StartCommand(ShellAuto) refused")
	}
	staged, err := NewLauncherStager(testLogger(), home).Stage(launcher)
	if err != nil {
		t.Fatalf("Stage: %v", err)
	}

	original := "ssh pi@raspberrypi"
	line := buildRewrittenLine(original, "'"+staged+"'")

	// THE assertion the bead was reopened for. A Linux canonical line buffer
	// is 4096 bytes (N_TTY_BUF_SIZE) and 4095 was the largest that survived
	// intact on a real pty. The launcher is 35243 bytes; the line that names
	// it is two orders of magnitude smaller.
	if len(line) > 4095 {
		t.Fatalf("rewritten line is %d bytes; a canonical tty line carries at most 4095", len(line))
	}
	if len(launcher) <= 4095 {
		t.Fatalf("launcher is only %d bytes — if it now fits a line, this whole indirection needs rereading", len(launcher))
	}
	t.Logf("launcher %d bytes staged; typed line %d bytes", len(launcher), len(line))

	// A real interactive bash on a real pty: the local tab.
	c := exec.Command(bash, "--norc", "--noprofile", "-i") // #nosec G204 — LookPath-resolved.
	c.Env = []string{
		"HOME=" + home,
		"TMPDIR=" + t.TempDir(),
		"TERM=xterm",
		"PATH=" + bin + string(os.PathListSeparator) + os.Getenv("PATH"),
		"PS1=" + ptyPrompt,
	}
	ptmx, err := pty.Start(c)
	if err != nil {
		t.Fatalf("pty start: %v", err)
	}
	defer func() { _ = ptmx.Close() }()

	done := make(chan string, 1)
	go func() {
		out, _ := io.ReadAll(ptmx)
		done <- string(out)
	}()
	defer func() {
		if c.Process != nil {
			_ = c.Process.Kill()
		}
	}()

	time.Sleep(600 * time.Millisecond)
	if _, werr := ptmx.Write([]byte(line + "\n")); werr != nil {
		t.Fatalf("write rewritten line: %v", werr)
	}
	// The remote (here: the re-exec'd bash) needs time to reach its first
	// prompt; the bash tier waits up to 250 ms for its snapshot job.
	time.Sleep(1500 * time.Millisecond)
	_, _ = ptmx.Write([]byte("exit\n"))
	time.Sleep(300 * time.Millisecond)
	_, _ = ptmx.Write([]byte("exit\n"))

	var out string
	select {
	case out = <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("timed out waiting for the session to end")
	}

	// 1. The launcher reached ssh's argv byte-identical. This is what the
	//    tty could not do and the file could: the terminal carried 145 bytes
	//    and the local shell handed 35243 to ssh through argv.
	got, rerr := os.ReadFile(argvOut) // #nosec G304 — test-owned path.
	if rerr != nil {
		t.Fatalf("the fake ssh was never reached (no remote command recorded): %v\noutput:\n%s", rerr, out)
	}
	if string(got) != launcher {
		t.Errorf("remote command differs from the staged launcher: got %d bytes, want %d", len(got), len(launcher))
		if len(got) < len(launcher) {
			t.Errorf("it was TRUNCATED — the payload is back on the tty; tail: %q", tailOf(string(got), 120))
		}
	}

	// 2. The far side got a shell that integrates: markers, from its own
	//    first prompt, with no dialog, no chip and no second action.
	ms := extractOscMarkers(out)
	if countMarkers(ms, "A") == 0 {
		t.Errorf("no OSC 133 A marker: the remote shell did not come up integrated\noutput:\n%s", out)
	}
	if countMarkers(ms, "B") == 0 {
		t.Errorf("no OSC 133 B marker: the remote shell did not come up integrated\noutput:\n%s", out)
	}

	// 3. The terminal never saw the payload. The user types a short line and
	//    the 35 KB never crosses the wire the tty owns — which is also why
	//    no fragment of it can be echoed, wrapped or executed.
	if strings.Contains(out, "printfBEscape") || strings.Contains(out, "__nocx_precmd()") {
		t.Error("launcher source text appeared on the terminal; the payload is crossing the tty again")
	}
}

// A staged file that is gone by the time the line runs is the failure the
// `[ -s … ]` guard exists for: the user gets their own command, an ordinary
// ssh, and never `ssh host ""` — which asks sshd for an empty remote command
// instead of a shell (ADR-0004 §1, fail-open).
func TestMissingStagedLauncherRunsTheLineTheUserTyped(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skipf("bash not installed: %v", err)
	}

	bin := t.TempDir()
	argvOut := filepath.Join(t.TempDir(), "remote-command")
	writeFakeSSH(t, bin, argvOut)

	// A path that was staged and then vanished — a crash between the RPC
	// and the Enter, or a line re-run from the shell's own history after
	// the pruner took the file.
	gone := filepath.Join(t.TempDir(), "launcher-vanished")
	original := "ssh pi@raspberrypi"
	line := buildRewrittenLine(original, "'"+gone+"'")

	// Run it non-interactively: the fallback branch is a plain command, and
	// what matters is which branch runs, not the prompt around it.
	c := exec.Command(bash, "-c", line) // #nosec G204 — LookPath-resolved; line is built above.
	c.Env = []string{
		"HOME=" + t.TempDir(),
		"PATH=" + bin + string(os.PathListSeparator) + os.Getenv("PATH"),
	}
	out, _ := c.CombinedOutput()

	// The else branch ran `ssh pi@raspberrypi` with no remote command, so
	// the stub recorded nothing: its last argument is the destination.
	got, rerr := os.ReadFile(argvOut) // #nosec G304 — test-owned path.
	if rerr != nil {
		t.Fatalf("ssh was never reached at all: %v\noutput: %s", rerr, out)
	}
	if string(got) != "pi@raspberrypi" {
		t.Errorf("fallback did not run the user's own line: ssh's last argument was %q, want the destination", got)
	}
	if strings.Contains(string(got), `""`) {
		t.Error(`ssh was handed an empty remote command; sshd would refuse a shell`)
	}
}

// tailOf returns the last n bytes of s, for reporting a truncation.
func tailOf(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
