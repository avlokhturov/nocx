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

// envDump renders what `printf <marker>; exec env -0` puts on stdout, so the
// parser tests state their input in the shape the shell actually produces.
func envDump(records ...string) string {
	out := envDumpMarker
	for _, r := range records {
		out += r + "\x00"
	}
	return out
}

// dumpEnvScript is the tail every fake shell in this package ends with: the
// marker, then the same `exec env -0` production runs. Fake shells that must
// resolve to a controlled environment run it under `env -i`.
const dumpEnvScript = "printf '" + envDumpMarker + "'\nexec /usr/bin/env -0\n"

// TestParseEnvDumpKeepsValuesVerbatim: there is no quoting to undo, so a
// value carrying spaces, quotes, an equals sign or a newline survives exactly
// — the class of value the export -p parser this replaced had to reconstruct,
// and could get wrong (nocx-58gq).
func TestParseEnvDumpKeepsValuesVerbatim(t *testing.T) {
	env, err := parseEnvDump(envDump(
		"PATH=/usr/bin:/bin",
		"SPACES=a b c",
		"QUOTES=say \"hi\" and 'bye'",
		"EQUALS=k=v",
		"MULTILINE=line1\nline2",
	))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, kv := range env {
		p := strings.IndexByte(kv, '=')
		got[kv[:p]] = kv[p+1:]
	}
	want := map[string]string{
		"PATH":      "/usr/bin:/bin",
		"SPACES":    "a b c",
		"QUOTES":    "say \"hi\" and 'bye'",
		"EQUALS":    "k=v",
		"MULTILINE": "line1\nline2",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if len(got) != len(want) {
		t.Errorf("parsed %d entries, want %d: %v", len(got), len(want), got)
	}
}

func TestParseEnvDumpDropsPWD(t *testing.T) {
	env, err := parseEnvDump(envDump("PWD=/stale/path", "KEEP=v"))
	if err != nil {
		t.Fatal(err)
	}
	for _, kv := range env {
		if strings.HasPrefix(kv, "PWD=") {
			t.Fatalf("PWD survived: %v", env)
		}
	}
}

// TestParseEnvDumpDiscardsWhatTheRcFilesPrinted: an rc file that greets the
// user writes to the same stdout, and the marker is what separates it from
// the dump. Nothing before the marker is parsed — not even a line that looks
// exactly like a record.
func TestParseEnvDumpDiscardsWhatTheRcFilesPrinted(t *testing.T) {
	env, err := parseEnvDump("welcome to the shell\nNOISE=not-an-entry\n" + envDump("PATH=/usr/bin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(env) != 1 || env[0] != "PATH=/usr/bin" {
		t.Fatalf("parsed = %v, want only the records after the marker", env)
	}
}

// TestParseEnvDumpWithoutMarkerDegrades: no marker means the shell never
// reached the dump — a degrade with a reason, never a silently empty
// environment that would read as "resolved, and it happens to be bare".
func TestParseEnvDumpWithoutMarkerDegrades(t *testing.T) {
	if _, err := parseEnvDump("PATH=/usr/bin\x00"); err == nil {
		t.Fatal("a dump with no marker parsed as an environment")
	}
}

func TestParseEnvDumpDropsMalformedRecords(t *testing.T) {
	env, err := parseEnvDump(envDump("PATH=/usr/bin", "=novalue", "bad name=x", "1LEADING=x"))
	if err != nil {
		t.Fatal(err)
	}
	if len(env) != 1 || env[0] != "PATH=/usr/bin" {
		t.Fatalf("parsed = %v, want only the well-formed record", env)
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
	if err := os.WriteFile(script, []byte("#!/bin/sh\n"+
		"printf '"+envDumpMarker+"'\nexec /usr/bin/env -i FOO=bar /usr/bin/env -0\n"), 0o755); err != nil {
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
	if err := os.WriteFile(shell, []byte("#!/bin/sh\n"+
		"printf '"+envDumpMarker+"'\nexec /usr/bin/env -i PATH=/usr/bin X=1 /usr/bin/env -0\n"), 0o755); err != nil {
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

// TestEnvCacheFailureRememberedThenRetried: a failed resolution is remembered
// — not re-attempted on every call, which is what turned one 5 s timeout into
// a tax on every open (nocx-6pz0) — but only for the cooldown: once it has
// passed, the next call retries, so a transient failure recovers instead of
// poisoning the cache for the process lifetime.
func TestEnvCacheFailureRememberedThenRetried(t *testing.T) {
	dir := t.TempDir()
	shell := filepath.Join(dir, "flaky-shell")
	count := filepath.Join(dir, "count")
	// #nosec G306 — the script must be executable: the resolver execs it.
	if err := os.WriteFile(shell, []byte("#!/bin/sh\nprintf x >> "+count+"\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	c := newEnvCache(shell, time.Second, 64<<10)

	if _, state, _ := c.resolve(context.Background()); state != git.EnvDegraded {
		t.Fatalf("first resolve: state = %s, want degraded", state)
	}
	// Within the cooldown the remembered failure is served without a retry.
	if _, state, _ := c.resolve(context.Background()); state != git.EnvDegraded {
		t.Fatalf("second resolve: state = %s, want degraded (remembered)", state)
	}
	// #nosec G304 — the count path is a test TempDir.
	if b, _ := os.ReadFile(count); len(b) != 1 {
		t.Fatalf("the failing probe ran %d times within the cooldown, want 1", len(b))
	}
	// Past the cooldown the next resolve retries — and a success is cached.
	c.lastTry = time.Now().Add(-time.Hour)
	// #nosec G306 — the script must be executable: the resolver execs it.
	if err := os.WriteFile(shell, []byte("#!/bin/sh\n"+
		"printf '"+envDumpMarker+"'\nexec /usr/bin/env -i PATH=/usr/bin /usr/bin/env -0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	env, state, _ := c.resolve(context.Background())
	if state != git.EnvResolved || !hasPATH(env) {
		t.Fatalf("retry resolve: state=%s env=%v, want resolved", state, env)
	}
}
