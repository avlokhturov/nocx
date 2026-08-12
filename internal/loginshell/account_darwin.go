//go:build darwin

package loginshell

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// readAccountShell asks Directory Services, which is macOS's account database
// — /etc/passwd on a Mac lists system accounts only, so parsing it the way the
// Linux side does would find no record for any real user. `dscl . -read` on the
// local node is what `chsh` writes and what Terminal.app and iTerm read, and it
// is the same answer whether nocx was started from a shell or from the Dock.
//
// The output is `UserShell: /bin/zsh` on one line; dscl folds a long value onto
// the following line, indented, so the continuation is accepted too rather than
// silently returning an empty shell for a user whose record happens to be long.
func readAccountShell() (string, error) {
	name := currentUsername()
	if name == "" {
		return "", errNoAccountShell
	}
	ctx, cancel := context.WithTimeout(context.Background(), accountLookupTimeout)
	defer cancel()
	// #nosec G204 — the argument is this process's own account name from
	// getpwuid (or $USER), interpolated into an argv that is never a shell.
	out, err := exec.CommandContext(ctx, "/usr/bin/dscl", ".", "-read", "/Users/"+name, "UserShell").Output()
	if err != nil {
		return "", fmt.Errorf("dscl UserShell for %q: %w", name, err)
	}
	shell := parseDSCLUserShell(string(out))
	if shell == "" {
		return "", errNoAccountShell
	}
	return shell, nil
}

// parseDSCLUserShell pulls the value out of dscl's key/value output.
func parseDSCLUserShell(out string) string {
	lines := strings.Split(out, "\n")
	for i, line := range lines {
		rest, ok := strings.CutPrefix(line, "UserShell:")
		if !ok {
			continue
		}
		if v := strings.TrimSpace(rest); v != "" {
			return v
		}
		// Folded value: dscl puts a long one on the next line, indented.
		if i+1 < len(lines) {
			return strings.TrimSpace(lines[i+1])
		}
	}
	return ""
}
