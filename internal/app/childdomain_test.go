package app

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/lifecyclepub"
)

// TestComposeSSHChildLine_LineIsExecutableAndCarriesTheForward is the ssh
// child's wire contract (ADR-0022: the ssh command line is the carrier):
// the grant's bootstrap is a SINGLE self-contained command line the parent
// evals — the -R reverse forward naming the child's listener, the
// destination, and the launcher command sshd runs on the far side. The line
// must parse under bash (the parent's shell) and must never lose the
// launcher command to quoting.
//
// What it must NOT do is wrap the client: nocx-beib. The bootstrap used to
// be piped into the client's stdin ahead of the connection, which took the
// terminal away from the authentication phase; the behavioural proof of
// that lives in childdomain_password_test.go, and the shape assertions
// here keep the pipe from creeping back.
func TestComposeSSHChildLine_LineIsExecutableAndCarriesTheForward(t *testing.T) {
	startCmd := `env -u BASH_ENV bash -c 'printf "it'"'"'s"'`
	line := composeSSHChildLine(startCmd, 40123, 37777, lifecyclepub.GrantRequest{
		Env: "ssh", Host: "box.example.com", User: "alice", Port: 2222,
	})

	if !strings.Contains(line, "-R 127.0.0.1:40123:127.0.0.1:37777") {
		t.Errorf("line does not carry the -R forward: %s", line)
	}
	if !strings.Contains(line, "-p 2222") {
		t.Errorf("line does not carry the typed port: %s", line)
	}
	if !strings.Contains(line, "'alice@box.example.com'") {
		t.Errorf("line does not carry the quoted destination: %s", line)
	}
	// One -t: the client's stdin is the parent's terminal, so OpenSSH
	// allocates the remote pty without being forced. -tt was a consequence
	// of the pipe and must not return with it.
	if !strings.Contains(line, "ssh -t -R") {
		t.Errorf("line does not request a remote pty with a single -t: %s", line)
	}
	if strings.Contains(line, "-tt") {
		t.Errorf("line forces a pty with -tt, which is only needed when the client's "+
			"stdin is not a terminal — the authentication phase needs it to be one: %s", line)
	}
	// No pipeline into ssh, and no termios window around it: both are the
	// in-band shape nocx-beib removed.
	if strings.Contains(line, "| ssh") || strings.Contains(line, "stty") {
		t.Errorf("line still wraps the client in a pipeline or a raw-mode window: %s", line)
	}

	// The line must parse under bash — the parent evals it verbatim, and a
	// quoting slip in the launcher command is a dead remote shell.
	f, err := os.CreateTemp(t.TempDir(), "line-*.sh")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(line + "\n"); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	// #nosec G204 — "bash" and a temp file this test just wrote; the point of
	// the test is that the composed line parses, which needs a real parser.
	cmd := exec.Command("bash", "-n", f.Name())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("composed line does not parse under bash: %v\n%s\nline:\n%s", err, out, line)
	}
}

// TestComposeSSHChildLine_StartCommandSurvivesQuoting proves the round trip
// of the launcher command's nastiest bytes: sshd must receive it byte for
// byte as ONE argument. The launcher command is ~38 KiB of shell with
// embedded quotes and newlines, so a quoting slip here is a far shell that
// dies on a syntax error with the user watching.
func TestComposeSSHChildLine_StartCommandSurvivesQuoting(t *testing.T) {
	startCmd := "line one\nline two with 'quotes' and \"double\" and \\backslashes\\ and $dollars\n"
	line := composeSSHChildLine(startCmd, 40123, 37777, lifecyclepub.GrantRequest{Env: "ssh", Host: "h"})

	// A stand-in ssh that prints its LAST argument — the command sshd would
	// run — so the bytes can be compared against what went in.
	binDir := t.TempDir()
	fakeSSH := "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\nprintf '%s' \"$last\"\n"
	// #nosec G306 — a stand-in for ssh must be executable to be found through
	// PATH; temp dir, no secret.
	if err := os.WriteFile(binDir+"/ssh", []byte(fakeSSH), 0o755); err != nil {
		t.Fatal(err)
	}
	prog := "PATH=" + binDir + ":$PATH\n" + line + "\n"
	// #nosec G204 — prog is the composed line under test plus a PATH pointing
	// at this test's temp dir; evaluating it under a real bash is the
	// assertion, not an accident.
	cmd := exec.Command("bash", "-c", prog)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("evaluating the composed line: %v\n%s", err, out)
	}
	if string(out) != startCmd {
		t.Errorf("sshd would receive %q, want the launcher command verbatim %q", string(out), startCmd)
	}
}
