package shellintegration

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The staging tests pin the property the whole of nocx-pu4.6 now rests on:
// the launcher reaches the local shell through a FILE, because it cannot
// reach it through the tty. A hand-typed ssh has only the terminal, whose
// canonical line buffer is 4096 bytes (N_TTY_BUF_SIZE), and the launcher is
// 35 KB — the payload was truncated mid-script and its tail executed as
// garbage. The staged file is read by the local shell at execution time and
// handed to ssh through argv, which is bounded by ARG_MAX, not MAX_CANON.

func TestStageWritesPayloadByteIdentical(t *testing.T) {
	home := t.TempDir()
	st := NewLauncherStager(testLogger(), home)

	launcher, _, ok := NewRemoteLauncher().StartCommand(ShellAuto, LaunchOptions{
		SessionID: "0123456789abcdef0123456789abcdef",
		Enhanced:  true,
	})
	if !ok {
		t.Fatal("StartCommand(ShellAuto) refused")
	}

	path, err := st.Stage(launcher)
	if err != nil {
		t.Fatalf("Stage: %v", err)
	}
	if !filepath.IsAbs(path) {
		t.Errorf("staged path %q is not absolute; the renderer splices it into a shell line", path)
	}

	got, err := os.ReadFile(path) // #nosec G304 — path is the stager's own return value.
	if err != nil {
		t.Fatalf("read staged file: %v", err)
	}
	if string(got) != launcher {
		t.Errorf("staged payload differs from the launcher: got %d bytes, want %d", len(got), len(launcher))
	}
	// The local shell reads this with `$(cat …)`, and command substitution
	// strips every trailing newline. Writing one would make the file and
	// the argument differ, so the file carries the payload exactly.
	if strings.HasSuffix(string(got), "\n") {
		t.Error("staged file ends with a newline; command substitution would strip it and the file would not match the argument")
	}
}

func TestStagePermissionsArePrivate(t *testing.T) {
	home := t.TempDir()
	st := NewLauncherStager(testLogger(), home)

	path, err := st.Stage("payload")
	if err != nil {
		t.Fatalf("Stage: %v", err)
	}

	// The file's contents become remote shell code the moment the local
	// shell reads it, so another user must not be able to write it.
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat staged file: %v", err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Errorf("staged file mode = %o, want 600", perm)
	}
	di, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat staging dir: %v", err)
	}
	if perm := di.Mode().Perm(); perm != 0o700 {
		t.Errorf("staging dir mode = %o, want 700", perm)
	}
}

// The staged file is consumed within milliseconds of being written — the RPC
// returns, the renderer pastes, the shell runs. Nothing deletes it on the
// happy path, so the pruner is what keeps a crash between write and execution
// from accumulating 35 KB files forever. Age is the only safe criterion: a
// live file is always newer than the TTL by many orders of magnitude, so a
// second backend pruning concurrently can never take one that is still wanted.
func TestStagePrunesOnlyExpiredFiles(t *testing.T) {
	home := t.TempDir()
	st := NewLauncherStager(testLogger(), home)

	fresh, err := st.Stage("fresh")
	if err != nil {
		t.Fatalf("Stage fresh: %v", err)
	}
	stale, err := st.Stage("stale")
	if err != nil {
		t.Fatalf("Stage stale: %v", err)
	}
	old := time.Now().Add(-2 * stageTTL)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	// Pruning happens on the next Stage: no lifecycle hook, no shutdown
	// path to forget, and nothing to run when no session is opening one.
	if _, err := st.Stage("trigger"); err != nil {
		t.Fatalf("Stage trigger: %v", err)
	}

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("stale staged file survived the prune: err = %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("fresh staged file was pruned: %v", err)
	}
}

func TestStageRefusesWhenDirectoryCannotBeCreated(t *testing.T) {
	// A regular file where the staging directory must go: MkdirAll fails,
	// Stage returns an error, and the transport answers with a refusal so
	// the renderer sends exactly what the user typed (ADR-0004 §1).
	home := t.TempDir()
	blocker := filepath.Join(home, dirName)
	if err := os.WriteFile(blocker, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("write blocker: %v", err)
	}

	st := NewLauncherStager(testLogger(), home)
	if path, err := st.Stage("payload"); err == nil {
		t.Errorf("Stage succeeded with an unusable staging directory: path = %q", path)
	}
}

func TestStageRefusesEmptyHome(t *testing.T) {
	// Without a home directory there is nowhere private to stage. Refusing
	// is the fail-open path: the original line is sent unchanged.
	st := NewLauncherStager(testLogger(), "")
	if path, err := st.Stage("payload"); err == nil {
		t.Errorf("Stage succeeded with no home directory: path = %q", path)
	}
}

// Two sessions staging at once must not share a file: each gets its own
// session id embedded in its own payload, and one overwriting the other
// would give a remote shell the wrong session's identity.
func TestStageGivesEachPayloadItsOwnFile(t *testing.T) {
	home := t.TempDir()
	st := NewLauncherStager(testLogger(), home)

	first, err := st.Stage("first payload")
	if err != nil {
		t.Fatalf("Stage first: %v", err)
	}
	second, err := st.Stage("second payload")
	if err != nil {
		t.Fatalf("Stage second: %v", err)
	}
	if first == second {
		t.Fatalf("both payloads staged to the same path %q", first)
	}

	a, err := os.ReadFile(first) // #nosec G304 — stager's own return value.
	if err != nil {
		t.Fatalf("read first: %v", err)
	}
	if string(a) != "first payload" {
		t.Errorf("first file = %q, want %q", a, "first payload")
	}
}
