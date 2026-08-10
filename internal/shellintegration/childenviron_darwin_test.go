//go:build darwin

package shellintegration

import (
	"bytes"
	"encoding/binary"
	"fmt"

	"golang.org/x/sys/unix"
)

// readChildEnviron returns the environment the kernel actually holds for pid.
//
// darwin has no /proc, so the source is sysctl KERN_PROCARGS2, whose buffer
// is: int32 argc, the executable path, NUL padding, then argc NUL-terminated
// argv strings, then the NUL-terminated environment strings. Reading it is
// permitted for a process of the same uid, which the shell under test is.
//
// Parsed exactly rather than scraped out of `ps -E`: the assertion this
// serves is that a 64-hex authenticator appears NOWHERE in the child's
// environment (ADR-0024 decision 2), and a whitespace-split of ps output
// silently loses any value containing a space — a leak check that can miss
// is worse than none. See the linux half for why the pair exists, and for
// why it is a copy of internal/app/childenviron_darwin_test.go.
func readChildEnviron(pid int) (map[string]string, error) {
	raw, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return nil, fmt.Errorf("kern.procargs2 for pid %d: %w", pid, err)
	}
	if len(raw) < 4 {
		return nil, fmt.Errorf("kern.procargs2 for pid %d: %d bytes, want at least 4", pid, len(raw))
	}
	argc := int(binary.LittleEndian.Uint32(raw[:4]))
	rest := raw[4:]

	// Skip the executable path and the NUL padding that follows it.
	i := bytes.IndexByte(rest, 0)
	if i < 0 {
		return nil, fmt.Errorf("kern.procargs2 for pid %d: no exec path terminator", pid)
	}
	rest = rest[i:]
	for len(rest) > 0 && rest[0] == 0 {
		rest = rest[1:]
	}

	// Skip argc argv strings; what remains is the environment.
	for n := 0; n < argc; n++ {
		j := bytes.IndexByte(rest, 0)
		if j < 0 {
			return nil, fmt.Errorf("kern.procargs2 for pid %d: argv %d unterminated", pid, n)
		}
		rest = rest[j+1:]
	}

	env := map[string]string{}
	for _, kv := range bytes.Split(rest, []byte{0}) {
		parts := bytes.SplitN(kv, []byte("="), 2)
		if len(parts) == 2 {
			env[string(parts[0])] = string(parts[1])
		}
	}
	return env, nil
}
