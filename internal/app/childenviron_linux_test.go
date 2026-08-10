//go:build linux

package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
)

// readChildEnviron returns the environment the kernel actually holds for pid.
//
// Linux publishes it directly. The darwin half of this pair goes through
// sysctl, and the split exists because the assertion that uses it —
// TestLocalEnhancedChildEnv_SecretNeverReachesIt — was written against
// /proc alone and therefore failed on macOS, which has no /proc at all: the
// one platform where "the capability never reaches the child's environment"
// most needs proving was the one platform not proving it (nocx-cn86).
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
