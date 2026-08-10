package shellintegration

// Cross-platform test helpers for the suites that spawn a real shell.
//
// cleanEnv lived in inband_pty_test.go, which is //go:build linux for a real
// reason — that suite seeds Linux termios bits whose meaning differs on
// darwin. But the helper itself is a string filter with no platform in it,
// and channel_exec_test.go and nested_domain_test.go (both untagged) call it,
// so on darwin the package tests referenced a function that was never
// compiled and the whole macOS backend job failed to build (nocx-7704).
//
// The tag stays where it belongs — on the suite whose assertions are Linux
// semantics — and the portable helper moves to a file with no tag at all.

import (
	"os"
	"strings"
)

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
