package local

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/git"
)

func TestOpenResolvesRealRepository(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "hi")

	repo, outcome, err := NewFactory(WithEnv(gitEnv(t))).Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.OpenOK {
		t.Fatalf("State = %s", outcome.State)
	}
	if outcome.Toplevel != dir {
		t.Fatalf("Toplevel = %q, want %q", outcome.Toplevel, dir)
	}
	if outcome.GitDir != filepath.Join(dir, ".git") {
		t.Fatalf("GitDir = %q", outcome.GitDir)
	}
	if !strings.HasPrefix(outcome.GitVersion, "git version 2.") {
		t.Fatalf("GitVersion = %q", outcome.GitVersion)
	}
	if outcome.EnvState != git.EnvResolved {
		t.Fatalf("EnvState = %s", outcome.EnvState)
	}
	if repo == nil {
		t.Fatal("ok outcome with a nil repo")
	}
}

func TestOpenEmptyCwd(t *testing.T) {
	repo, outcome, err := NewFactory(WithEnv(gitEnv(t))).Open(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.OpenNoCwd {
		t.Fatalf("State = %s, want noCwd", outcome.State)
	}
	if repo != nil {
		t.Fatal("noCwd outcome with a repo")
	}
}

func TestOpenNotARepository(t *testing.T) {
	dir := t.TempDir() // exists, but not a repository
	repo, outcome, err := NewFactory(WithEnv(gitEnv(t))).Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.OpenNotARepository {
		t.Fatalf("State = %s, want notARepository", outcome.State)
	}
	if repo != nil {
		t.Fatal("notARepository outcome with a repo")
	}
}

func TestOpenGitUnavailable(t *testing.T) {
	// A PATH with no git at all: the probe cannot find the binary.
	empty := t.TempDir()
	env := []string{"PATH=" + empty, "HOME=" + t.TempDir()}
	repo, outcome, err := NewFactory(WithEnv(env)).Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.OpenGitUnavailable {
		t.Fatalf("State = %s, want gitUnavailable", outcome.State)
	}
	if repo != nil {
		t.Fatal("gitUnavailable outcome with a repo")
	}
}

func TestOpenGitTooOld(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_GIT_VERSION": "2.20.0"})
	repo, outcome, err := NewFactory(WithEnv(env)).Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.OpenGitTooOld {
		t.Fatalf("State = %s, want gitTooOld", outcome.State)
	}
	if outcome.GitVersion != "git version 2.20.0" {
		t.Fatalf("GitVersion = %q — the outcome carries the version it found", outcome.GitVersion)
	}
	if repo != nil {
		t.Fatal("gitTooOld outcome with a repo")
	}
}

func TestOpenCurrentGitAccepted(t *testing.T) {
	env := fakeGitEnv(t, nil) // default version 2.55.0
	repo, outcome, err := NewFactory(WithEnv(env)).Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.OpenOK {
		t.Fatalf("State = %s", outcome.State)
	}
	if repo == nil {
		t.Fatal("ok outcome with a nil repo")
	}
}

// TestOpenRevParseMalformed: rev-parse's output is validated, not trusted —
// one line, three lines, or a relative path is notARepository, never a path
// we hand to a subprocess.
func TestOpenRevParseMalformed(t *testing.T) {
	cases := map[string]string{
		"one line":      "/only/one\n",
		"three lines":   "/one\n/two\n/three\n",
		"relative path": "relative\nrelative/.git\n",
		"empty":         "\n\n",
	}
	for name, answer := range cases {
		t.Run(name, func(t *testing.T) {
			env := fakeGitEnv(t, map[string]string{"FAKE_REVPARSE": answer})
			repo, outcome, err := NewFactory(WithEnv(env)).Open(context.Background(), t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			if outcome.State != git.OpenNotARepository {
				t.Fatalf("State = %s, want notARepository for rev-parse output %q", outcome.State, answer)
			}
			if repo != nil {
				t.Fatal("notARepository outcome with a repo")
			}
		})
	}
}

func TestOpenRevParseFailingExit(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_REVPARSE": "FAIL"})
	repo, outcome, err := NewFactory(WithEnv(env)).Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.OpenNotARepository {
		t.Fatalf("State = %s, want notARepository", outcome.State)
	}
	if repo != nil {
		t.Fatal("notARepository outcome with a repo")
	}
}

func TestOpenContextCancelled(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_STATUS": "sleep"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := NewFactory(WithEnv(env)).Open(ctx, t.TempDir())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Open returned %v, want context.Canceled", err)
	}
}

// TestOpenOutcomeRepoConsistency is the factory's half of the ownership rule
// (spec §5.1 rule 1): a non-nil Repo iff the outcome is ok. The composition
// layer still checks both directions explicitly; the factory must never
// produce the malformed pair in the first place.
func TestOpenOutcomeRepoConsistency(t *testing.T) {
	dir := newGitRepo(t)
	realEnv := gitEnv(t)
	empty := t.TempDir()

	cases := []struct {
		name string
		env  []string
		cwd  string
	}{
		{"real repo", realEnv, dir},
		{"empty cwd", realEnv, ""},
		{"not a repo", realEnv, empty},
		{"no git", []string{"PATH=" + t.TempDir(), "HOME=" + t.TempDir()}, empty},
		{"too old", fakeGitEnv(t, map[string]string{"FAKE_GIT_VERSION": "git version 2.10.0"}), empty},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			repo, outcome, err := NewFactory(WithEnv(c.env)).Open(context.Background(), c.cwd)
			if err != nil {
				return // cancelled-like errors are not outcome pairs
			}
			ok := outcome.State == git.OpenOK
			if ok && repo == nil {
				t.Fatal("ok outcome with a nil repo — the (nil, ok) direction")
			}
			if !ok && repo != nil {
				t.Fatalf("refusing outcome %s with a non-nil repo", outcome.State)
			}
		})
	}
}

func TestCapabilityProbeCached(t *testing.T) {
	env := fakeGitEnv(t, nil)
	f := NewFactory(WithEnv(env))
	for i := 0; i < 3; i++ {
		repo, outcome, err := f.Open(context.Background(), t.TempDir())
		if err != nil || outcome.State != git.OpenOK || repo == nil {
			t.Fatalf("open %d: %v %s", i, err, outcome.State)
		}
	}
	// The probe ran once: --version appears exactly once in the argv log.
	calls := fakeGitLog(t, env)
	versions := 0
	for _, call := range calls {
		if len(call) == 1 && call[0] == "--version" {
			versions++
		}
	}
	if versions != 1 {
		t.Fatalf("version probe ran %d times, want 1 (cached)", versions)
	}
}

func TestVersionFloor(t *testing.T) {
	cases := []struct {
		version string
		below   bool
	}{
		{"git version 2.24.9", true},
		{"git version 2.25.0", false},
		{"git version 2.55.0", false},
		{"git version 3.0.0", false},
		{"git version 1.8.3", true},
		{"garbage", true},
	}
	for _, c := range cases {
		if got := belowFloor(c.version); got != c.below {
			t.Errorf("belowFloor(%q) = %v, want %v", c.version, got, c.below)
		}
	}
}

func TestResolveGitScansEnvPath(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "git")
	if err := writeFileExec(script, "#!/bin/sh\nexit 0\n"); err != nil {
		t.Fatal(err)
	}
	got, err := resolveGit([]string{"PATH=" + dir + ":/usr/bin"})
	if err != nil {
		t.Fatal(err)
	}
	if got != script {
		t.Fatalf("resolveGit = %q, want %q", got, script)
	}
	if _, err := resolveGit([]string{"PATH=" + t.TempDir()}); err == nil {
		t.Fatal("resolveGit found git in an empty PATH")
	}
}

func writeFileExec(path, content string) error {
	return writeFile(path, content, 0o755)
}
