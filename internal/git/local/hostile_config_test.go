package local

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/git"
)

// The panel reads a repository whose git config belongs to the user, not to
// us, and D6 runs git under the user's resolved environment. So "what git
// prints" is not a constant: two ordinary configurations change it in ways
// that would break the panel silently rather than loudly. Both were measured
// on git 2.55 before these tests were written.

// TestDiffIgnoresExternalDiffDriver: a user with diff.external set — anyone
// using difftastic or delta as a diff DRIVER — makes plain `git diff` return
// that program's output instead of a unified diff. The panel renders the
// text AS a unified diff, so without --no-ext-diff it would decorate
// arbitrary prose and show the user nonsense with no error anywhere.
//
// Measured: with diff.external pointing at a script that echoes one line,
// `git diff` returns exactly that line; --no-ext-diff returns the real diff.
func TestDiffIgnoresExternalDiffDriver(t *testing.T) {
	dir := diffRepo(t)

	script := filepath.Join(t.TempDir(), "extdiff.sh")
	if err := writeFile(script, "#!/bin/sh\necho 'TOTALLY NOT A UNIFIED DIFF'\n", 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := exec.Command(realGitPath(t), "config", "diff.external", script) // #nosec G204 — realGitPath is LookPath-resolved; script is the test's own t.TempDir() path
	cfg.Dir = dir
	cfg.Env = gitEnv(t)
	if out, err := cfg.CombinedOutput(); err != nil {
		t.Fatalf("git config diff.external: %v: %s", err, out)
	}

	repo := openRepo(t, gitEnv(t), dir)
	d, err := repo.Diff(context.Background(), "tracked.txt", git.SideUnstaged, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if d.State != git.DiffOK {
		t.Fatalf("State = %s", d.State)
	}
	if strings.Contains(d.Text, "TOTALLY NOT A UNIFIED DIFF") {
		t.Fatalf("the external driver replaced the diff: %q", d.Text)
	}
	if !strings.Contains(d.Text, "@@") || !strings.Contains(d.Text, "+changed") {
		t.Fatalf("not a unified diff: %q", d.Text)
	}
}

// TestStatusDoesNotRewriteTheIndex: the panel polls this question every few
// seconds while an agent runs git in the terminal beside it. A plain
// `git status` opportunistically refreshes and REWRITES .git/index, so a
// reader would be mutating the repository twelve times a minute — which is
// interference, not observation, and is what --no-optional-locks exists for.
//
// Measured: after `touch` on a tracked file, a plain status moves the index
// mtime; the same status with the flag leaves it alone.
func TestStatusDoesNotRewriteTheIndex(t *testing.T) {
	dir := diffRepo(t)
	repo := openRepo(t, gitEnv(t), dir)
	index := filepath.Join(dir, ".git", "index")

	// Make the stat cache stale, which is what tempts git to refresh it.
	if err := os.Chtimes(filepath.Join(dir, "tracked.txt"), time.Now(), time.Now()); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}

	if _, statusErr := repo.Status(context.Background()); statusErr != nil {
		t.Fatal(statusErr)
	}

	after, err := os.Stat(index)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("status rewrote .git/index (%s -> %s): the panel must not mutate the repository it is reading",
			before.ModTime(), after.ModTime())
	}
}
