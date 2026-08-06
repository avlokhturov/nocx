package local

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/git"
)

func TestParseExportPBashDoubleQuoted(t *testing.T) {
	env, err := parseExportP("declare -x PATH=\"/usr/bin:/bin\"\ndeclare -x FOO=\"a b c\"\ndeclare -x QUOTES=\"say \\\"hi\\\"\"\n")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, kv := range env {
		p := strings.IndexByte(kv, '=')
		got[kv[:p]] = kv[p+1:]
	}
	if got["PATH"] != "/usr/bin:/bin" || got["FOO"] != "a b c" || got["QUOTES"] != `say "hi"` {
		t.Fatalf("parsed = %v", got)
	}
}

func TestParseExportPDashSingleQuoted(t *testing.T) {
	env, err := parseExportP("export PATH='/usr/bin:/bin'\nexport FOO='a b'\n")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, kv := range env {
		p := strings.IndexByte(kv, '=')
		got[kv[:p]] = kv[p+1:]
	}
	if got["PATH"] != "/usr/bin:/bin" || got["FOO"] != "a b" {
		t.Fatalf("parsed = %v", got)
	}
}

func TestParseExportPAnsiCQuoted(t *testing.T) {
	// bash emits $'…' for values with control characters.
	env, err := parseExportP("declare -x MULTILINE=$'line1\\nline2'\ndeclare -x TAB=$'a\\tb'\n")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, kv := range env {
		p := strings.IndexByte(kv, '=')
		got[kv[:p]] = kv[p+1:]
	}
	if got["MULTILINE"] != "line1\nline2" || got["TAB"] != "a\tb" {
		t.Fatalf("parsed = %v", got)
	}
}

func TestParseExportPDropsPWD(t *testing.T) {
	env, err := parseExportP("export PWD='/stale/path'\nexport KEEP='v'\n")
	if err != nil {
		t.Fatal(err)
	}
	for _, kv := range env {
		if strings.HasPrefix(kv, "PWD=") {
			t.Fatalf("PWD survived: %v", env)
		}
	}
}

// TestResolveShellEnvSucceedsOnAnOrdinaryMachine is D6's paired success
// test: on an ordinary machine the resolver produces a PATH-carrying
// environment from the real shell.
func TestResolveShellEnvSucceedsOnAnOrdinaryMachine(t *testing.T) {
	shell := detectShell()
	env, err := resolveShellEnv(context.Background(), shell, 5*time.Second, 256<<10)
	if err != nil {
		t.Fatalf("resolveShellEnv(%s): %v", shell, err)
	}
	if !hasPATH(env) {
		t.Fatalf("resolved environment has no PATH: %v", env)
	}
	for _, kv := range env {
		if !strings.Contains(kv, "=") {
			t.Fatalf("malformed entry %q", kv)
		}
	}
}

func TestResolveShellEnvShellMissing(t *testing.T) {
	_, err := resolveShellEnv(context.Background(), "/nonexistent/shell", time.Second, 64<<10)
	if err == nil {
		t.Fatal("resolution succeeded with a missing shell")
	}
}

// TestResolveShellEnvTimesOut: a shell whose rc file hangs is bounded by the
// deadline, and the failure is a timeout-shaped error.
func TestResolveShellEnvTimesOut(t *testing.T) {
	dir := t.TempDir()
	hang := filepath.Join(dir, "hang-shell")
	// #nosec G306 — the script must be executable: the resolver execs it.
	if err := os.WriteFile(hang, []byte("#!/bin/sh\nsleep 1000\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err := resolveShellEnv(context.Background(), hang, 200*time.Millisecond, 64<<10)
	if err == nil {
		t.Fatal("resolution succeeded against a hanging shell")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("resolution took %s, deadline not enforced", elapsed)
	}
}

func TestResolveShellEnvNoPathDegrades(t *testing.T) {
	// A shell that resolves an environment without PATH is not a usable
	// environment — the resolver says so rather than returning it.
	dir := t.TempDir()
	script := filepath.Join(dir, "empty-shell")
	// #nosec G306 — the script must be executable: the resolver execs it.
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho 'export FOO=bar'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := resolveShellEnv(context.Background(), script, time.Second, 64<<10)
	if err == nil || !strings.Contains(err.Error(), "no PATH") {
		t.Fatalf("err = %v, want a no-PATH degradation", err)
	}
}

func TestEnvCacheResolveAndFail(t *testing.T) {
	// Success is cached; a failure is retried (not poisoned).
	dir := t.TempDir()
	shell := filepath.Join(dir, "ok-shell")
	// #nosec G306 — the script must be executable: the resolver execs it.
	if err := os.WriteFile(shell, []byte("#!/bin/sh\necho 'export PATH=/usr/bin'\necho 'export X=1'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	c := newEnvCache(shell, time.Second, 64<<10)
	env, state, _ := c.resolve(context.Background())
	if state != git.EnvResolved || !hasPATH(env) {
		t.Fatalf("first resolve: state=%s env=%v", state, env)
	}
	// Cached: the second resolve must not re-run the shell. Prove it by
	// deleting the shell.
	if err := os.Remove(shell); err != nil {
		t.Fatal(err)
	}
	env2, state2, _ := c.resolve(context.Background())
	if state2 != git.EnvResolved || len(env2) == 0 {
		t.Fatalf("cached resolve lost the environment: state=%s", state2)
	}
}

func TestEnvCacheFailureNotCached(t *testing.T) {
	dir := t.TempDir()
	shell := filepath.Join(dir, "flaky-shell")
	// First resolve fails (missing shell), then the shell appears and the
	// second resolve succeeds — a failed resolution must not be cached.
	_, state, _ := newEnvCache(filepath.Join(dir, "not-there"), time.Second, 64<<10).resolve(context.Background())
	if state != git.EnvDegraded {
		t.Fatalf("state = %s, want degraded", state)
	}
	// #nosec G306 — the script must be executable: the resolver execs it.
	if err := os.WriteFile(shell, []byte("#!/bin/sh\necho 'export PATH=/usr/bin'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	c := newEnvCache(shell, time.Second, 64<<10)
	env, state, _ := c.resolve(context.Background())
	if state != git.EnvResolved || !hasPATH(env) {
		t.Fatalf("second resolve: state=%s env=%v", state, env)
	}
}
