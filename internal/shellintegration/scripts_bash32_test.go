package shellintegration

import (
	"os/exec"
	"strings"
	"testing"
)

// macOS still ships GNU bash 3.2.57 as /bin/bash — Apple froze it at the last
// GPLv2 release in 2007 — and this is a macOS-first product, so 3.2 is the
// OLDEST bash the integration script must load in, not an edge case.
//
// The trap this test exists for: a version test cannot guard SYNTAX. bash
// parses a function's whole body before executing any of it, so
//
//	if (( BASH_VERSINFO[0] >= 4 )); then coproc name { ...; }; fi
//
// is rejected by 3.2 at the `coproc` token even though the branch is never
// taken. That shipped (nocx-cn86): every bash shell on macOS died at
// "syntax error near unexpected token `}'" while sourcing, started with no
// integration at all, and 30 tests in this package went red on the macOS CI
// job — the ONLY gate in the repo that runs a real 3.2. A bash-4+ construct
// belongs inside an `eval` string, which is parsed when the branch runs.
//
// A parse check, deliberately, not an execution one: what 3.2 must do is
// accept the file. What it then DOES on macOS is covered by the tests in
// scripts_exec_test.go, which run against /bin/bash on the macOS runner.
func TestBashScript_ParsesUnderBash32(t *testing.T) {
	bash32 := requireBash32(t)
	script := writeScriptFile(t, "nocx.bash", bashScript)

	// -n: read and parse, run nothing.
	// #nosec G204 — bash32 is the requireBash32-resolved path and script is
	// this test's own temp file; neither is input.
	out, err := exec.Command(bash32, "-n", script).CombinedOutput()
	if err != nil {
		t.Fatalf("the shipped bash script does not parse under bash 3.2 (macOS /bin/bash):\n%s\n"+
			"A bash 4+ construct outside an eval is the usual cause — a runtime version\n"+
			"guard does not help, because bash parses the whole body first.", out)
	}
}

// requireBash32 returns a path to a GNU bash 3.2. It prefers /bin/bash when
// that IS 3.2 (macOS), and otherwise takes `bash32` from PATH, which the
// pre-commit test image provides (.githooks/images/go-tests/Dockerfile).
//
// It fails rather than skips, for the reason nocx-gd84 gave for zsh: a skip
// here reports green on every Linux machine in the project, which is every
// machine except the CI runner that found the bug in the first place.
func requireBash32(t *testing.T) string {
	t.Helper()
	for _, cand := range []string{"bash32", "/bin/bash"} {
		path, err := exec.LookPath(cand)
		if err != nil {
			continue
		}
		// #nosec G204 — path came from exec.LookPath over a fixed candidate list.
		out, err := exec.Command(path, "--version").Output()
		if err != nil {
			continue
		}
		if strings.Contains(string(out), "version 3.2") {
			return path
		}
	}
	t.Fatal("no GNU bash 3.2 found (looked for `bash32` on PATH and a 3.2 /bin/bash).\n" +
		"Run the tests the way the hook does — the container image installs it:\n" +
		"  sh -c '. ./.githooks/containerized-tests.sh; go_test_containerized' .githooks/pre-commit")
	return ""
}
