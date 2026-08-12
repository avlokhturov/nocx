//go:build !darwin && !windows

package loginshell

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"strings"
)

// passwdFile is the account database of last resort. A variable so the test
// can point the /etc/passwd arm at a fixture instead of at the machine's own
// record, which is the thing the test must not depend on.
var passwdFile = "/etc/passwd"

// readAccountShell reads the passwd database: `getent passwd` first, the file
// second.
//
// getent first because it asks the name service, so a user that lives in LDAP,
// SSSD or NIS — which is most of a managed fleet — has a record to find at all;
// /etc/passwd holds only the local half. The file second because getent is
// absent from busybox images and from some minimal containers, and the local
// record is right there. Both arms return the same shape, so a failure of the
// first is not a failure of the lookup.
func readAccountShell() (string, error) {
	name := currentUsername()
	if name == "" {
		return "", errNoAccountShell
	}
	if shell := getentShell(name); shell != "" {
		return shell, nil
	}
	if shell := passwdFileShell(name); shell != "" {
		return shell, nil
	}
	return "", errNoAccountShell
}

// getentShell asks the name service. An empty string means "no answer here",
// never "no shell": the caller falls through to the file.
func getentShell(name string) string {
	ctx, cancel := context.WithTimeout(context.Background(), accountLookupTimeout)
	defer cancel()
	// #nosec G204 — the argument is this process's own account name from
	// getpwuid (or $USER), interpolated into an argv that is never a shell.
	out, err := exec.CommandContext(ctx, "getent", "passwd", name).Output()
	if err != nil {
		return ""
	}
	return shellFromPasswdLines(string(out), name)
}

// passwdFileShell reads the local record.
func passwdFileShell(name string) string {
	f, err := os.Open(passwdFile)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	var b strings.Builder
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		b.WriteString(sc.Text())
		b.WriteByte('\n')
	}
	return shellFromPasswdLines(b.String(), name)
}

// shellFromPasswdLines returns the shell field of the record for name. A
// record whose shell field is EMPTY is not a match: POSIX reads that as
// "the implementation default", which is /bin/sh, and answering /bin/sh from
// here would outrank a perfectly good $SHELL. Leaving it unanswered lets the
// resolver's own chain make that call, which is where the decision belongs.
func shellFromPasswdLines(out, name string) string {
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(line, ":")
		if len(fields) < 7 || fields[0] != name {
			continue
		}
		if shell := strings.TrimSpace(fields[6]); shell != "" {
			return shell
		}
	}
	return ""
}
