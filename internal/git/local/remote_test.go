package local

// RemoteURL tests (brief, nocx-hc0m): the URL of the remote the current
// branch tracks, derived by git. The successes run against the real git —
// each one is the paired "and on an ordinary repository it produces exactly
// this URL" (AGENTS.md rule 2) — and the no-answer cases are ordinary
// results (ErrNoRemote), never errors: detached HEAD, no upstream, a
// deleted remote, a local upstream. The invocation-failure paths run
// against the fake git.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/git"
)

// remoteFixture builds a real repository whose current branch tracks a
// remote with the given fetch URL, returning the repo and the branch name.
func remoteFixture(t *testing.T, remoteURL string) (string, string) {
	t.Helper()
	dir := newGitRepo(t)
	gitWrite(t, dir, "a.txt", "a\n")
	gitCommit(t, dir, "first")
	out, err := commandIn(dir, "branch", "--show-current").Output()
	if err != nil {
		t.Fatalf("branch --show-current: %v", err)
	}
	branch := strings.TrimSpace(string(out))
	if branch == "" {
		t.Fatal("fixture branch empty")
	}
	for _, args := range [][]string{
		{"remote", "add", "origin", remoteURL},
		{"config", "branch." + branch + ".remote", "origin"},
		{"config", "branch." + branch + ".merge", "refs/heads/" + branch},
	} {
		if err := commandIn(dir, args...).Run(); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	return dir, branch
}

// wantNoRemote fails the test unless err is the ErrNoRemote none-case.
func wantNoRemote(t *testing.T, err error) {
	t.Helper()
	var noRemote *git.ErrNoRemote
	if !errors.As(err, &noRemote) {
		t.Fatalf("RemoteURL = %v, want ErrNoRemote", err)
	}
}

// TestRemoteURLSucceedsOnAnOrdinaryRepository is the paired assertion: an
// scp-style remote answers exactly its own URL — the spelling the panel
// must convert, never a URL it invented.
func TestRemoteURLSucceedsOnAnOrdinaryRepository(t *testing.T) {
	env := gitEnv(t)
	dir, _ := remoteFixture(t, "git@github.com:shady2k/nocx.git")
	repo := openRepo(t, env, dir)
	url, err := repo.RemoteURL(context.Background())
	if err != nil {
		t.Fatalf("RemoteURL: %v", err)
	}
	if url != "git@github.com:shady2k/nocx.git" {
		t.Fatalf("RemoteURL = %q, want the remote's own URL", url)
	}
}

// TestRemoteURLHttpsRemoteIsReadVerbatim — the https spelling of the same
// repository must come back verbatim too; the conversion lives in the
// renderer, so the seam must not normalise.
func TestRemoteURLHttpsRemoteIsReadVerbatim(t *testing.T) {
	env := gitEnv(t)
	dir, _ := remoteFixture(t, "https://github.com/shady2k/nocx.git")
	repo := openRepo(t, env, dir)
	url, err := repo.RemoteURL(context.Background())
	if err != nil {
		t.Fatalf("RemoteURL: %v", err)
	}
	if url != "https://github.com/shady2k/nocx.git" {
		t.Fatalf("RemoteURL = %q", url)
	}
}

// TestRemoteURLNoRemoteIsTheNoneCase — a repository with no remote at all is
// the common case, and it is ErrNoRemote, never an error.
func TestRemoteURLNoRemoteIsTheNoneCase(t *testing.T) {
	env := gitEnv(t)
	dir := newGitRepo(t)
	gitWrite(t, dir, "a.txt", "a\n")
	gitCommit(t, dir, "first")
	repo := openRepo(t, env, dir)
	_, err := repo.RemoteURL(context.Background())
	wantNoRemote(t, err)
}

// TestRemoteURLDetachedHeadIsTheNoneCase — a detached HEAD has no branch,
// hence no upstream, hence nothing to open.
func TestRemoteURLDetachedHeadIsTheNoneCase(t *testing.T) {
	env := gitEnv(t)
	dir := newGitRepo(t)
	gitWrite(t, dir, "a.txt", "a\n")
	gitCommit(t, dir, "first")
	if err := commandIn(dir, "remote", "add", "origin", "git@github.com:shady2k/nocx.git").Run(); err != nil {
		t.Fatalf("remote add: %v", err)
	}
	if err := commandIn(dir, "checkout", "--detach").Run(); err != nil {
		t.Fatalf("checkout --detach: %v", err)
	}
	repo := openRepo(t, env, dir)
	_, err := repo.RemoteURL(context.Background())
	wantNoRemote(t, err)
}

// TestRemoteURLNoUpstreamIsTheNoneCase — a remote exists but the branch
// does not track it: nothing to open.
func TestRemoteURLNoUpstreamIsTheNoneCase(t *testing.T) {
	env := gitEnv(t)
	dir := newGitRepo(t)
	gitWrite(t, dir, "a.txt", "a\n")
	gitCommit(t, dir, "first")
	if err := commandIn(dir, "remote", "add", "origin", "git@github.com:shady2k/nocx.git").Run(); err != nil {
		t.Fatalf("remote add: %v", err)
	}
	repo := openRepo(t, env, dir)
	_, err := repo.RemoteURL(context.Background())
	wantNoRemote(t, err)
}

// TestRemoteURLDeletedRemoteIsTheNoneCase — the branch tracks origin but
// the remote was deleted: git remote get-url exits non-zero, and that is
// the none case, not a failure.
func TestRemoteURLDeletedRemoteIsTheNoneCase(t *testing.T) {
	env := gitEnv(t)
	dir, branch := remoteFixture(t, "git@github.com:shady2k/nocx.git")
	if err := commandIn(dir, "remote", "remove", "origin").Run(); err != nil {
		t.Fatalf("remote remove: %v", err)
	}
	// Removing the remote also drops branch.<name>.remote; re-add the
	// config only, so the tracking says origin while the remote is gone.
	if err := commandIn(dir, "config", "branch."+branch+".remote", "origin").Run(); err != nil {
		t.Fatalf("config: %v", err)
	}
	repo := openRepo(t, env, dir)
	_, err := repo.RemoteURL(context.Background())
	wantNoRemote(t, err)
}

// TestRemoteURLLocalUpstreamIsTheNoneCase — a branch tracking ANOTHER local
// branch (%(upstream:remotename) answers ".") has no hosting to open.
func TestRemoteURLLocalUpstreamIsTheNoneCase(t *testing.T) {
	env := gitEnv(t)
	dir := newGitRepo(t)
	gitWrite(t, dir, "a.txt", "a\n")
	gitCommit(t, dir, "first")
	for _, args := range [][]string{
		{"branch", "tracked"},
		{"checkout", "-b", "feature"},
		{"config", "branch.feature.remote", "."},
		{"config", "branch.feature.merge", "refs/heads/tracked"},
	} {
		if err := commandIn(dir, args...).Run(); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	repo := openRepo(t, env, dir)
	_, err := repo.RemoteURL(context.Background())
	wantNoRemote(t, err)
}

// TestRemoteURLDetachedViaFakeGitPinsTheExitCode — the fake git's
// symbolic-ref FAIL mode is an exit-1 refusal, and that exit IS the
// detached answer: ErrNoRemote, not an error.
func TestRemoteURLDetachedViaFakeGitPinsTheExitCode(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_SYMBOLIC_REF": "FAIL",
	})
	repo := openRepo(t, env, t.TempDir())
	_, err := repo.RemoteURL(context.Background())
	wantNoRemote(t, err)
}

// TestRemoteURLNoUpstreamViaFakeGit — the atom prints an empty line for a
// branch with no upstream; emptiness is the none case.
func TestRemoteURLNoUpstreamViaFakeGit(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_UPSTREAM_REMOTE": "-",
	})
	repo := openRepo(t, env, t.TempDir())
	_, err := repo.RemoteURL(context.Background())
	wantNoRemote(t, err)
}

// TestRemoteURLDeletedRemoteViaFakeGit — git remote get-url exits 128 for
// a remote that no longer exists; the fake's FAIL mode is that exit, and
// the answer is still the none case.
func TestRemoteURLDeletedRemoteViaFakeGit(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_REMOTE_URL": "FAIL",
	})
	repo := openRepo(t, env, t.TempDir())
	_, err := repo.RemoteURL(context.Background())
	wantNoRemote(t, err)
}

// TestRemoteURLUpstreamReadFailureIsAnError — for-each-ref carries NO data
// in its exit code ("no upstream" and "branch gone" both print an empty
// line and exit 0), so a non-zero exit is an invocation problem, and it
// propagates as an error rather than masquerading as the none case.
func TestRemoteURLUpstreamReadFailureIsAnError(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_UPSTREAM_REMOTE": "FAIL",
	})
	repo := openRepo(t, env, t.TempDir())
	_, err := repo.RemoteURL(context.Background())
	if err == nil {
		t.Fatal("RemoteURL with a failing upstream read succeeded")
	}
	var noRemote *git.ErrNoRemote
	if errors.As(err, &noRemote) {
		t.Fatalf("RemoteURL = ErrNoRemote, want an invocation error")
	}
}

// TestRemoteURLReadsTwoAndThreeShareTheStartFailurePath — all three reads
// go through the same run() exec path, so a git that cannot START fails
// identically at each position; read 1's failure is proven above, and the
// missing-git case here exercises the same mechanism for the later reads
// by removing the fake between them (the for-each-ref run deletes the
// script, so the get-url spawn cannot start).
func TestRemoteURLReadsTwoAndThreeShareTheStartFailurePath(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_SELF_DELETE": "1",
	})
	repo := openRepo(t, env, t.TempDir())
	_, err := repo.RemoteURL(context.Background())
	if err == nil {
		t.Fatal("RemoteURL with a vanished git succeeded")
	}
	var noRemote *git.ErrNoRemote
	if errors.As(err, &noRemote) {
		t.Fatalf("RemoteURL = ErrNoRemote, want an invocation error")
	}
}

// TestRemoteURLGitUnavailableIsAnError — an invocation that cannot be made
// (no git at all) is the one real failure, and it propagates as an error,
// never as the none case.
func TestRemoteURLGitUnavailableIsAnError(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{})
	repo := openRepo(t, env, t.TempDir())
	r, ok := repo.(*Repo)
	if !ok {
		t.Fatal("openRepo did not return a *Repo")
	}
	r.gitPath = "/nonexistent/git"
	_, err := repo.RemoteURL(context.Background())
	if err == nil {
		t.Fatal("RemoteURL with no git succeeded")
	}
	var noRemote *git.ErrNoRemote
	if errors.As(err, &noRemote) {
		t.Fatalf("RemoteURL = ErrNoRemote, want an invocation error")
	}
}
