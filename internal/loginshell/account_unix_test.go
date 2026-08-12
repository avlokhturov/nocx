//go:build !darwin && !windows

package loginshell

import (
	"os"
	"path/filepath"
	"testing"
)

// TestShellFromPasswdLines covers the passwd record shapes that decide whether
// a Linux user gets their own shell. The empty-shell case is the one worth
// stating: POSIX reads an empty seventh field as "the implementation default",
// and answering /bin/sh from here would OUTRANK a perfectly good $SHELL,
// because the account record is the first step of the chain.
func TestShellFromPasswdLines(t *testing.T) {
	const db = "root:x:0:0:root:/root:/bin/bash\n" +
		"svc:x:998:998::/var/empty:\n" +
		"alex:x:1000:1000:Alex:/home/alex:/usr/bin/zsh\n" +
		"short:x:1001:1001:broken\n"

	tests := []struct {
		name string
		user string
		want string
	}{
		{"an ordinary record", "alex", "/usr/bin/zsh"},
		{"root", "root", "/bin/bash"},
		{"an empty shell field is not an answer", "svc", ""},
		{"a truncated record is not an answer", "short", ""},
		{"no such user", "nobody-here", ""},
		{"a prefix of a real name does not match", "ale", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shellFromPasswdLines(db, tt.user); got != tt.want {
				t.Errorf("shellFromPasswdLines(_, %q) = %q, want %q", tt.user, got, tt.want)
			}
		})
	}
}

// TestPasswdFileShell_ReadsTheFile is the file arm's paired success: getent is
// absent from busybox images and from some minimal containers, so the file arm
// is the one that has to work there, and a test that only exercised the parser
// would not notice if the reader stopped opening anything.
func TestPasswdFileShell_ReadsTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "passwd")
	if err := os.WriteFile(path, []byte("alex:x:1000:1000:Alex:/home/alex:/usr/bin/fish\n"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	orig := passwdFile
	passwdFile = path
	defer func() { passwdFile = orig }()

	if got := passwdFileShell("alex"); got != "/usr/bin/fish" {
		t.Errorf("passwdFileShell = %q, want /usr/bin/fish", got)
	}
	// A file that is not there is a miss, never a crash: the resolver falls
	// through to $SHELL.
	passwdFile = filepath.Join(t.TempDir(), "absent")
	if got := passwdFileShell("alex"); got != "" {
		t.Errorf("passwdFileShell with no passwd file = %q, want an empty miss", got)
	}
}

// TestReadAccountShell_ReadsThisMachinesRecord is the platform half of the
// paired assertion on Linux: the container the gate runs in must be able to
// name its own login shell, or the fix for nocx-wwz0 does not work there.
func TestReadAccountShell_ReadsThisMachinesRecord(t *testing.T) {
	shell, err := readAccountShell()
	if err != nil {
		t.Fatalf("readAccountShell for %q: %v", currentUsername(), err)
	}
	if !filepath.IsAbs(shell) {
		t.Fatalf("account shell %q is not an absolute path", shell)
	}
}
