//go:build linux

package shellintegration

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
)

// readChildEnviron returns the environment the kernel actually holds for pid.
//
// Linux publishes it directly; the darwin half of the pair goes through
// sysctl. The split exists because the assertion that uses it —
// TestBashChannel_CapabilityNeverInAnyEnvironment — was written against
// /proc alone and so could not run on macOS, which has no /proc at all: the
// one platform where "the capability never reaches any environment" most
// needs proving was the one platform not proving it (nocx-cn86).
//
// This is a byte-identical copy of internal/app/childenviron_linux_test.go,
// which asserts the same property one layer up. A test file cannot be shared
// across packages, and lifting it into a non-test package would put a
// function nothing reachable from main() calls into the tree — which the
// deadcode ratchet exists to refuse, and whose baseline may only shrink.
// Change one, change both.
func readChildEnviron(pid int) (map[string]string, error) {
	raw, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "environ"))
	if err != nil {
		return nil, err
	}
	env := map[string]string{}
	for _, kv := range bytes.Split(raw, []byte{0}) {
		parts := bytes.SplitN(kv, []byte("="), 2)
		if len(parts) == 2 {
			env[string(parts[0])] = string(parts[1])
		}
	}
	return env, nil
}
