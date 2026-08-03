package sandbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixturePolicy builds a Policy with one writable root, one read-only root,
// and a distinct shell file path.
func fixturePolicy(t *testing.T) *Policy {
	t.Helper()
	base := t.TempDir()
	ws := filepath.Join(base, "workspace")
	rt := filepath.Join(base, "runtime")
	for _, d := range []string{ws, filepath.Join(rt, "home"), filepath.Join(rt, "tmp")} {
		if err := os.MkdirAll(d, 0o750); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}
	p, err := BuildPolicy(ws, "/bin/sh", rt, nil)
	if err != nil {
		t.Fatalf("BuildPolicy: %v", err)
	}
	return p
}

func TestRenderProfile_Deterministic(t *testing.T) {
	p := fixturePolicy(t)
	a, err := renderProfile(p)
	if err != nil {
		t.Fatalf("renderProfile: %v", err)
	}
	b, err := renderProfile(p)
	if err != nil {
		t.Fatalf("renderProfile: %v", err)
	}
	if a != b {
		t.Fatal("renderProfile is not deterministic")
	}
}

func TestRenderProfile_Clauses(t *testing.T) {
	p := fixturePolicy(t)
	profile, err := renderProfile(p)
	if err != nil {
		t.Fatalf("renderProfile: %v", err)
	}

	if !strings.HasPrefix(profile, "(version 1)\n(deny default)\n") {
		t.Error("profile must begin with (version 1) and (deny default)")
	}
	if !strings.Contains(profile, "(allow network*)") {
		t.Error("profile must contain (allow network*) — network is out of scope")
	}
	for _, root := range p.WritableRoots {
		want := `(allow file-write* (subpath "` + root + `"))`
		if !strings.Contains(profile, want) {
			t.Errorf("profile missing writable clause for %q", root)
		}
	}
	for _, root := range p.ReadOnlyRoots {
		if root == p.Shell {
			continue
		}
		want := `(allow file-read* (subpath "` + root + `"))`
		if !strings.Contains(profile, want) {
			t.Errorf("profile missing read-only clause for %q", root)
		}
	}
	wantShell := `(allow file-read* (literal "` + p.Shell + `"))`
	if !strings.Contains(profile, wantShell) {
		t.Errorf("profile missing literal shell clause for %q", p.Shell)
	}
	if !strings.Contains(profile, "(allow file-write-data (vnode-type CHARACTER-DEVICE))") {
		t.Error("profile missing PTY character-device write clause")
	}
	if !strings.Contains(profile, "(allow file-ioctl (vnode-type CHARACTER-DEVICE))") {
		t.Error("profile missing PTY character-device ioctl clause")
	}
}

func TestRenderProfile_RejectsInjection(t *testing.T) {
	p := fixturePolicy(t)
	// A malicious path with a newline must fail closed at render time.
	p.WritableRoots = append(p.WritableRoots, "/tmp/evil\x07root")
	if _, err := renderProfile(p); err == nil {
		t.Fatal("expected renderProfile to reject control-character path")
	}
}

func TestEscapeSBPL(t *testing.T) {
	// Control characters, including newline and NUL, are rejected.
	for _, bad := range []string{"a\nb", "a\x00b", "\x07", "\x1b[31m"} {
		if _, err := escapeSBPL(bad); err == nil {
			t.Errorf("escapeSBPL(%q): expected rejection", bad)
		}
	}
	// Backslash and quote are escaped; everything else passes through.
	got, err := escapeSBPL(`/tmp/a"b\c`)
	if err != nil {
		t.Fatalf("escapeSBPL: %v", err)
	}
	if got != `/tmp/a\"b\\c` {
		t.Errorf("escapeSBPL = %q, want %q", got, `/tmp/a\"b\\c`)
	}
	if _, err := escapeSBPL(""); err == nil {
		t.Error("escapeSBPL(\"\"): expected rejection")
	}
}
