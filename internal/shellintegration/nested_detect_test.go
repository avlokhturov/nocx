package shellintegration

import (
	"fmt"
	"testing"
)

// TestBashNestedDetection exercises the nested-environment classifier
// directly: the sudo/su/ssh detection must be conservative — accepted
// forms only, everything ambiguous refused (which means: run
// conventionally).
func TestBashNestedDetection(t *testing.T) {
	bash := requireShell(t, "bash")
	script := writeScriptFile(t, "nocx.bash", bashScript)
	cases := []struct {
		line string
		env  string
		host string
		port string
		user string
	}{
		{"sudo -i", "sudo", "", "", ""},
		{"sudo --login", "sudo", "", "", ""},
		{"sudo -s", "sudo", "", "", ""},
		{"sudo -i ls", "", "", "", ""},
		{"sudo apt-get install x", "", "", "", ""},
		{"su", "su", "", "", ""},
		{"su -", "su", "", "", ""},
		{"su -l alice", "su", "", "", ""},
		{"su -c 'whoami'", "", "", "", ""},
		{"ssh host.example.com", "ssh", "host.example.com", "", ""},
		{"ssh -p 2222 alice@box.example.com", "ssh", "box.example.com", "2222", "alice"},
		{"ssh -t -p 2222 box", "ssh", "box", "2222", ""},
		{"ssh box ls", "", "", "", ""},
		{"ssh -L 8080:localhost:80 box", "", "", "", ""},
		{"ssh box; rm -rf /", "", "", "", ""},
		{"echo hi", "", "", "", ""},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("%q", tc.line), func(t *testing.T) {
			// No capability: the script's init fails fast (cfg check) and
			// never blocks on a handshake; the detect latch is set after
			// sourcing, which is exactly the state the preexec hook sees.
			prog := fmt.Sprintf(`
export NOCX_SHELL_INTEGRATION=1
export NOCX_LIFECYCLE_LANE=lane-test
export NOCX_LIFECYCLE_DOMAIN=dom-test
export NOCX_LIFECYCLE_EPOCH=1
export NOCX_LIFECYCLE_FD=3
source "$1"
__nocx_lc_active=1
__nocx_nested_detect %q
printf 'ENV=%%s HOST=%%s USER=%%s PORT=%%s\n' "$__nocx_nested_env" "$__nocx_nested_host" "$__nocx_nested_user" "$__nocx_nested_port"
`, tc.line)
			out := runShellProg(t, bash, prog, script)
			want := fmt.Sprintf("ENV=%s HOST=%s USER=%s PORT=%s", tc.env, tc.host, tc.user, tc.port)
			if !containsSubstring(out, want) {
				t.Errorf("detect(%q) = %q, want %q", tc.line, out, want)
			}
		})
	}
}

func containsSubstring(haystack, needle string) bool {
	return len(needle) == 0 || indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
