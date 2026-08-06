package shellintegration

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestPosixIntegration_EmitsMarkersFromPS1 drives the REAL interactive dash
// and busybox ash through the PS1-only prompt path — the mechanism the
// minimal tier lives on (POSIX sh has no PROMPT_COMMAND, so the only seam is
// PS1 re-expansion at each prompt; a test that invoked a hook function by
// hand could not catch a prompt that was never installed). It asserts, per
// prompt, the stream D A B with the real exit status on the THIRD prompt (a
// PS1 assigned with double quotes expands $? once, at install time, and
// freezes that value into the prompt forever — the regression this catches),
// that OSC 7 carries an absolute path and follows a cd, and that no C marker
// is ever emitted: C is unreachable through portable prompt hooks and faking
// it is forbidden.
func TestPosixIntegration_EmitsMarkersFromPS1(t *testing.T) {
	script := writeScriptFile(t, "nocx.posix", posixScript)
	// Resolved, because the shell reports the PHYSICAL directory and this test
	// compares its OSC 7 against a path it built itself. On macOS t.TempDir()
	// hands back /var/folders/..., which is a symlink to /private/var/folders/...
	// — so the shell said /private/var and the test wanted /var, and the same
	// assertion passed on linux where nothing redirects /var. Two derivations of
	// one path, agreeing everywhere except the platform we ship (nocx-0ije).
	dir1 := resolvedTempDir(t)
	dir2 := resolvedTempDir(t)

	cases := []struct {
		name  string
		shell string
		args  []string
	}{
		{name: "dash", shell: "dash"},
		{name: "busybox-ash", shell: "busybox", args: []string{"ash"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			requireShell(t, tc.shell)

			// Five marker prompts, before each driver line after the source
			// (the prompt before the source still shows the default PS1).
			// D payloads: 0 (the source's own status — a POSIX prompt
			// expansion forks, so the first prompt's D cannot be suppressed
			// the way bash/zsh suppress theirs; every frontend consumer
			// ignores a D while no command is running), then 0 after `true`,
			// 1 after `false`, 0 after `true`, 0 after the cd.
			driver := `. "$NOCX_SCRIPT_PATH"
true
false
true
cd "$NOCX_CD_DIR"
exit
`
			// #nosec G204 — test-only: shell and args come from this file's own
			// table of literals, never from input.
			cmd := exec.Command(tc.shell, append(tc.args, "-i")...)
			cmd.Dir = dir1
			cmd.Env = append(
				os.Environ(),
				"HOSTNAME=testhost",
				"NOCX_SHELL_INTEGRATION=1",
				"NOCX_SCRIPT_PATH="+script,
				"NOCX_CD_DIR="+dir2,
			)
			cmd.Stdin = strings.NewReader(driver)
			outBytes, err := cmd.CombinedOutput()
			if err != nil {
				t.Logf("%s exited non-zero (may be benign): %v", tc.shell, err)
			}
			out := string(outBytes)

			ms := extractOscMarkers(out)
			var kinds strings.Builder
			for _, m := range ms {
				kinds.WriteString(m.kind)
			}
			if kinds.String() != "DABDABDABDABDAB" {
				t.Errorf("marker stream = %q, want DAB x5 (D before A before B, no C); output:\n%s", kinds.String(), out)
			}

			wantStatuses := []string{"0", "0", "1", "0", "0"}
			if got := extractDStatuses(out); !equalStrings(got, wantStatuses) {
				t.Errorf("D statuses = %v, want %v (the D;1 on the third prompt is what a double-quoted PS1 freeze would miss); output:\n%s", got, wantStatuses, out)
			}

			osc7 := extractOsc7(out)
			if len(osc7) != 5 {
				t.Fatalf("OSC 7 payload count = %d, want 5; output:\n%s", len(osc7), out)
			}
			if osc7[0] != "file://testhost"+urlEncode(dir1) {
				t.Errorf("first OSC 7 = %q, want file://testhost%s (absolute cwd at startup)", osc7[0], urlEncode(dir1))
			}
			if osc7[len(osc7)-1] != "file://testhost"+urlEncode(dir2) {
				t.Errorf("last OSC 7 = %q, want file://testhost%s (OSC 7 must follow the cd)", osc7[len(osc7)-1], urlEncode(dir2))
			}
			for i, p := range osc7 {
				if !strings.HasPrefix(p, "file://testhost/") {
					t.Errorf("OSC 7 %d = %q: not an absolute file:// URL", i, p)
				}
			}
		})
	}
}

// extractDStatuses returns the exit codes carried by every OSC 133 D marker,
// in stream order. Candidates that are not pure digits are skipped — the
// text before the first marker (shell noise, the default PS1) lands in the
// first split element and must not count as a status.
func extractDStatuses(out string) []string {
	var ss []string
	for _, part := range strings.Split(out, "\x1b]133;D;") {
		end := strings.IndexAny(part, "\a\x1b")
		if end < 0 {
			continue
		}
		s := part[:end]
		if s != "" && isDigits(s) {
			ss = append(ss, s)
		}
	}
	return ss
}

func isDigits(s string) bool {
	for i := range s {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// extractOsc7 returns the OSC 7 payloads (from "file://" to the terminating
// BEL), in stream order. Only candidates that actually start a file:// URL
// are kept, for the same reason as extractDStatuses.
func extractOsc7(out string) []string {
	var ps []string
	for _, part := range strings.Split(out, "\x1b]7;") {
		end := strings.IndexByte(part, 0x07)
		if end < 0 {
			continue
		}
		p := part[:end]
		if strings.HasPrefix(p, "file://") {
			ps = append(ps, p)
		}
	}
	return ps
}

// urlEncode mirrors the shell script's __nocx_encode_url: space, tab and
// newline are percent-encoded; everything else passes through.
func urlEncode(s string) string {
	r := strings.NewReplacer(" ", "%20", "\t", "%09", "\n", "%0a")
	return r.Replace(s)
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestPosixEmitsPassportAndTaggedMarkers drives the REAL interactive dash and
// busybox ash with an environment id set and asserts the minimal-tier
// readiness passport is emitted exactly once at source time and the A/B/D
// markers are tagged nocx_env=<id> — the fixture's exact sequences. The
// minimal tier never emits C (POSIX sh has no preexec hook), and a tagged
// stream must not invent one.
func TestPosixEmitsPassportAndTaggedMarkers(t *testing.T) {
	fx := loadPassportFixtures(t)
	script := writeScriptFile(t, "nocx.posix", posixScript)

	cases := []struct {
		name  string
		shell string
		args  []string
	}{
		{name: "dash", shell: "dash"},
		{name: "busybox-ash", shell: "busybox", args: []string{"ash"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			requireShell(t, tc.shell)

			driver := `. "$NOCX_SCRIPT_PATH"
true
exit
`
			// #nosec G204 — test-only: shell and args come from this file's own
			// table of literals, never from input.
			cmd := exec.Command(tc.shell, append(tc.args, "-i")...)
			cmd.Dir = t.TempDir()
			cmd.Env = append(
				os.Environ(),
				"HOSTNAME=testhost",
				"NOCX_SHELL_INTEGRATION=1",
				"NOCX_ENVIRONMENT_ID="+fx.EnvironmentID,
				"NOCX_SCRIPT_PATH="+script,
			)
			cmd.Stdin = strings.NewReader(driver)
			outBytes, err := cmd.CombinedOutput()
			if err != nil {
				t.Logf("%s exited non-zero (may be benign): %v", tc.shell, err)
			}
			out := string(outBytes)

			passport := fx.Passports["minimal"].Sequence
			if n := strings.Count(out, passport); n != 1 {
				t.Errorf("passport emitted %d times, want exactly once; output:\n%s", n, out)
			}
			for name, want := range map[string]string{
				"tagged A":   fx.Markers["A"].Sequence,
				"tagged B":   fx.Markers["B"].Sequence,
				"tagged D;0": fx.Markers["D0"].Sequence,
			} {
				if !strings.Contains(out, want) {
					t.Errorf("missing %s (%q); output:\n%s", name, want, out)
				}
			}
			if strings.Contains(out, "]133;C") {
				t.Errorf("minimal tier must never emit a C marker; output:\n%s", out)
			}
		})
	}
}

// TestPosixRefusesPassportForMalformedEnvironmentId is the dash half of the
// fail-open refusal test: a malformed id must produce no passport and no
// tagged marker. The posix validation is the trickiest (no regex — case glob
// plus a length bound), so this is where a charset slip would surface.
func TestPosixRefusesPassportForMalformedEnvironmentId(t *testing.T) {
	requireShell(t, "dash")
	script := writeScriptFile(t, "nocx.posix", posixScript)
	for _, id := range loadPassportFixtures(t).Invalid.EnvironmentIDs {
		t.Run(id.Name, func(t *testing.T) {
			driver := `. "$NOCX_SCRIPT_PATH"
exit
`
			// #nosec G204 — test-only: literals from this file, never input.
			cmd := exec.Command("dash", "-i")
			cmd.Dir = t.TempDir()
			cmd.Env = append(
				os.Environ(),
				"HOSTNAME=testhost",
				"NOCX_SHELL_INTEGRATION=1",
				"NOCX_ENVIRONMENT_ID="+id.Value,
				"NOCX_SCRIPT_PATH="+script,
			)
			cmd.Stdin = strings.NewReader(driver)
			outBytes, err := cmd.CombinedOutput()
			if err != nil {
				t.Logf("dash exited non-zero (may be benign): %v", err)
			}
			out := string(outBytes)
			if strings.Contains(out, "]636;P") {
				t.Errorf("emitted a passport for malformed environment id %q; output:\n%s", id.Value, out)
			}
			if strings.Contains(out, "nocx_env=") {
				t.Errorf("tagged a marker for malformed environment id %q; output:\n%s", id.Value, out)
			}
		})
	}
}

// resolvedTempDir is t.TempDir() with every symlink resolved, so a path this
// test builds can be compared with a path a shell reports.
func resolvedTempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolve temp dir: %v", err)
	}
	return dir
}
