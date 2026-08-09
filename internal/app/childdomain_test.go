package app

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/lifecyclepub"
	"github.com/shady2k/nocx/internal/shellintegration"
)

// TestComposeSSHChildLine_LineIsExecutableAndCarriesTheForward is the ssh
// child's wire contract (ADR-0022: the ssh command line is the carrier):
// the grant's bootstrap is a SINGLE self-contained command line the parent
// evals — the -R reverse forward naming the child's listener, the in-band
// stream (wrapper, capability, payload, terminator) piped into `ssh -t`,
// the keyboard bridge after it, and the termios save/restore around the
// raw-mode window. The line must parse under bash (the parent's shell) and
// must never lose the payload bytes to quoting.
func TestComposeSSHChildLine_LineIsExecutableAndCarriesTheForward(t *testing.T) {
	plan := shellintegration.InBandPlan{
		Wrapper:    `saved=$(stty -g); printf 'it'\''s "quoted"\n'`,
		Capability: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
		Payload:    "# nocx payload\nprintf '%s' \"a 'single' and a \\backslash\\\"\n",
		Terminator: "NOCX_IB_EOF",
	}
	line := composeSSHChildLine(plan, 40123, 37777, lifecyclepub.GrantRequest{
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
	if !strings.Contains(line, "stty raw -echo; cat; } | ssh -t") {
		t.Errorf("line lacks the keyboard bridge: %s", line)
	}

	// The line must parse under bash — the parent evals it verbatim, and a
	// quoting slip in the payload is a dead remote shell.
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

// TestComposeSSHChildLine_PayloadBytesSurviveQuoting proves the round trip
// of the payload's nastiest bytes through the composed line's quoting: the
// parent evals the line, and the printed stream must be byte-identical to
// the payload the remote wrapper reads. This is the ADR-0022 carrier
// contract at the quoting layer.
func TestComposeSSHChildLine_PayloadBytesSurviveQuoting(t *testing.T) {
	payload := "line one\nline two with 'quotes' and \"double\" and \\backslashes\\ and $dollars\n"
	line := composeSSHChildLine(shellintegration.InBandPlan{
		Wrapper:    "w",
		Capability: "cap",
		Payload:    payload,
		Terminator: "NOCX_IB_EOF",
	}, 40123, 37777, lifecyclepub.GrantRequest{Env: "ssh", Host: "h"})

	// The line evals to: stty save; { printf ...; } | ssh ... — extract the
	// payload by evaluating the printf it contains: run the whole line under
	// bash but with a fake ssh on PATH that cats its stdin.
	binDir := t.TempDir()
	fakeSSH := "#!/bin/sh\ncat\n"
	// #nosec G306 — a stand-in for ssh must be executable to be found through
	// PATH; temp dir, no secret.
	if err := os.WriteFile(binDir+"/ssh", []byte(fakeSSH), 0o755); err != nil {
		t.Fatal(err)
	}
	// The line's ssh -t -R ... 'h' — the fake ssh ignores args and cats
	// stdin; the pipeline's stdout is the stream. The stty calls fail
	// harmlessly outside a tty; the whole line is wrapped so its status
	// dance does not abort.
	prog := "PATH=" + binDir + ":$PATH\n" + line + "\n"
	// #nosec G204 — prog is the composed line under test plus a PATH pointing
	// at this test's temp dir; evaluating it under a real bash is the
	// assertion, not an accident.
	cmd := exec.Command("bash", "-c", prog)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("evaluating the composed line: %v\n%s", err, out)
	}
	got := string(out)
	for _, want := range []string{"w\n", "cap\n", payload, "NOCX_IB_EOF\n"} {
		if !strings.Contains(got, want) {
			t.Errorf("stream missing %q; got:\n%s", want, got)
		}
	}
}
