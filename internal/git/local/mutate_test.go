package local

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/git"
)

func TestStageAndUnstageRealGit(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "v1")
	gitCommit(t, dir, "one")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("v2"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo := openRepo(t, gitEnv(t), dir)

	st, err := repo.Stage(context.Background(), []string{"f.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Staged) != 1 || st.Staged[0].Path != "f.txt" {
		t.Fatalf("after stage: %s", summary(st))
	}

	st, err = repo.Unstage(context.Background(), []string{"f.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Staged) != 0 {
		t.Fatalf("after unstage: %s", summary(st))
	}
	if len(st.Unstaged) != 1 {
		t.Fatalf("file must be back in unstaged: %s", summary(st))
	}
}

func TestStageEmptyPathsIsANoOp(t *testing.T) {
	dir := newGitRepo(t)
	repo := openRepo(t, gitEnv(t), dir)
	if _, err := repo.Stage(context.Background(), nil); err == nil {
		t.Fatal("Stage with no paths must refuse — an empty slice is never 'all'")
	}
}

func TestStageAllUnbornRealGit(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "a.txt", "a")
	gitWrite(t, dir, "b.txt", "b")
	repo := openRepo(t, gitEnv(t), dir)

	st, err := repo.StageAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Staged) != 2 {
		t.Fatalf("after stage-all on unborn: %s", summary(st))
	}
}

// TestUnstageAllUnbornRealGit is the measured case that dictated bare
// git reset (D19): it succeeds on an unborn branch, where git restore
// --staged fails on an unresolvable HEAD.
func TestUnstageAllUnbornRealGit(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "hi")
	repo := openRepo(t, gitEnv(t), dir)
	if _, err := repo.StageAll(context.Background()); err != nil {
		t.Fatal(err)
	}

	st, err := repo.UnstageAll(context.Background())
	if err != nil {
		t.Fatalf("unstage-all on an unborn branch must work: %v", err)
	}
	if len(st.Staged) != 0 {
		t.Fatalf("after unstage-all: %s", summary(st))
	}
	if len(st.Unstaged) != 1 || st.Unstaged[0].X != '?' {
		t.Fatalf("file must be untracked again (in unstaged with ? columns): %s", summary(st))
	}
}

// TestStageAllRefusedWhileConflicted is D19's measured hazard: git add -A
// with an unresolved conflict marks it resolved using the marker-laden
// worktree file. The refusal is the only safe answer.
func TestStageAllRefusedWhileConflicted(t *testing.T) {
	dir := conflictedRepo(t)
	repo := openRepo(t, gitEnv(t), dir)

	_, err := repo.StageAll(context.Background())
	if err == nil {
		t.Fatal("StageAll succeeded during an unresolved merge")
	}
	var c *git.ErrConflicted
	if !errors.As(err, &c) {
		t.Fatalf("StageAll returned %T, want *git.ErrConflicted", err)
	}
	if c.Path != "f.txt" {
		t.Fatalf("ErrConflicted.Path = %q", c.Path)
	}
	assertStillConflicted(t, dir)
}

// TestUnstageAllRefusedWhileConflicted is D19's other measured hazard: bare
// git reset during a conflicted merge deletes .git/MERGE_HEAD, silently
// aborting the merge. The refusal is the only safe answer.
func TestUnstageAllRefusedWhileConflicted(t *testing.T) {
	dir := conflictedRepo(t)
	repo := openRepo(t, gitEnv(t), dir)

	_, err := repo.UnstageAll(context.Background())
	if err == nil {
		t.Fatal("UnstageAll succeeded during an unresolved merge")
	}
	var c *git.ErrConflicted
	if !errors.As(err, &c) {
		t.Fatalf("UnstageAll returned %T, want *git.ErrConflicted", err)
	}
	assertStillConflicted(t, dir)
}

func TestCommitHappyPathRealGit(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "v1")
	gitCommit(t, dir, "one")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("v2"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo := openRepo(t, gitEnv(t), dir)
	if _, err := repo.Stage(context.Background(), []string{"f.txt"}); err != nil {
		t.Fatal(err)
	}

	outcome, err := repo.Commit(context.Background(), "fix: change f\n\nbody here", false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.CommitOK {
		t.Fatalf("State = %s", outcome.State)
	}
	if len(outcome.Head) == 0 {
		t.Fatal("Head empty after a successful commit")
	}
	if outcome.StatusStale {
		t.Fatal("status reported stale after a successful commit")
	}
	if len(outcome.Status.Staged) != 0 || len(outcome.Status.Unstaged) != 0 {
		t.Fatalf("post-commit status not clean: %s", summary(outcome.Status))
	}

	// The commit is real: HEAD message is the one we sent, with the body.
	hm, err := repo.HeadMessage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if hm.State != git.HeadMessageOK || !strings.Contains(hm.Message, "body here") {
		t.Fatalf("HeadMessage = %+v", hm)
	}
}

func TestCommitNothingToCommit(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "hi")
	gitCommit(t, dir, "one")
	repo := openRepo(t, gitEnv(t), dir)

	_, err := repo.Commit(context.Background(), "nothing", false)
	if err == nil {
		t.Fatal("Commit succeeded with nothing staged")
	}
	if !errors.As(err, new(*git.ErrNothingToCommit)) {
		t.Fatalf("Commit returned %T, want *git.ErrNothingToCommit", err)
	}
}

func TestCommitAmendOnUnbornRefused(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "hi")
	repo := openRepo(t, gitEnv(t), dir)

	_, err := repo.Commit(context.Background(), "amend me", true)
	if err == nil {
		t.Fatal("amend on an unborn branch succeeded")
	}
	if !errors.As(err, new(*git.ErrAmendUnborn)) {
		t.Fatalf("Commit returned %T, want *git.ErrAmendUnborn", err)
	}
}

func TestCommitAmendRealGit(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "v1")
	gitCommit(t, dir, "original subject")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("v2"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo := openRepo(t, gitEnv(t), dir)
	if _, err := repo.Stage(context.Background(), []string{"f.txt"}); err != nil {
		t.Fatal(err)
	}

	outcome, err := repo.Commit(context.Background(), "amended subject", true)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.CommitOK {
		t.Fatalf("State = %s", outcome.State)
	}
	hm, _ := repo.HeadMessage(context.Background())
	if !strings.Contains(hm.Message, "amended subject") || strings.Contains(hm.Message, "original") {
		t.Fatalf("amend did not replace the message: %+v", hm)
	}
}

// TestCommitFailedCarriesGitOutput: a non-zero exit is ONE failed state with
// git's own account, not a classification of why.
func TestCommitFailedCarriesGitOutput(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_COMMIT": "fail", "FAKE_STATUS": "staged"})
	repo := openRepo(t, env, t.TempDir())

	outcome, err := repo.Commit(context.Background(), "msg", false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.CommitFailed {
		t.Fatalf("State = %s", outcome.State)
	}
	if !strings.Contains(outcome.Output, "pre-commit hook declined") {
		t.Fatalf("Output = %q", outcome.Output)
	}
	if outcome.OutputTruncated {
		t.Fatal("output truncated on a short failure")
	}
}

// TestCommitStderrOverBound: the stderr bound is reported, not hidden, and
// the reader does not deadlock.
func TestCommitStderrOverBound(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_COMMIT": "fail_flood", "FAKE_STATUS": "staged"})
	repo := openRepo(t, env, t.TempDir())

	outcome, err := repo.Commit(context.Background(), "msg", false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.CommitFailed {
		t.Fatalf("State = %s", outcome.State)
	}
	if !outcome.OutputTruncated {
		t.Fatal("OutputTruncated not set although the bound was reached")
	}
	if len(outcome.Output) > 2*git.MaxCommitOutputBytes {
		t.Fatalf("Output = %d bytes, over the %d-byte bound", len(outcome.Output), git.MaxCommitOutputBytes)
	}
}

// TestCommitSucceedsHeadReadFails: the commit happened; the outcome says ok
// with an unknown head — the panel must say "committed", not "failed".
func TestCommitSucceedsHeadReadFails(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_COMMIT": "ok", "FAKE_HEAD": "FAIL", "FAKE_STATUS": "staged"})
	repo := openRepo(t, env, t.TempDir())

	outcome, err := repo.Commit(context.Background(), "msg", false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.CommitOK {
		t.Fatalf("State = %s, want ok — the commit happened", outcome.State)
	}
	if outcome.Head != "" {
		t.Fatalf("Head = %q, want empty when the head read failed", outcome.Head)
	}
}

// TestCommitSucceedsStatusFails: the commit happened; the outcome names the
// stale status rather than rendering a zero status as fresh.
func TestCommitSucceedsStatusFails(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_COMMIT": "ok", "FAKE_STATUS": "staged_then_fail"})
	repo := openRepo(t, env, t.TempDir())

	outcome, err := repo.Commit(context.Background(), "msg", false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.State != git.CommitOK {
		t.Fatalf("State = %s, want ok", outcome.State)
	}
	if !outcome.StatusStale {
		t.Fatal("StatusStale not set although the post-commit status failed")
	}
	if outcome.Status.Staged == nil {
		t.Fatal("a stale status must still marshal its lists as [], never null")
	}
}

// TestMutationSucceededStatusFailed: the stage happened, the status after it
// failed — the caller is told the view is stale; nothing is reverted.
func TestMutationSucceededStatusFailed(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_MUTATE": "ok", "FAKE_STATUS": "fail"})
	repo := openRepo(t, env, t.TempDir())

	_, err := repo.Stage(context.Background(), []string{"f.txt"})
	if err == nil {
		t.Fatal("Stage succeeded despite the failing post-status")
	}
	if !strings.Contains(err.Error(), "index corrupt") {
		t.Fatalf("Stage returned %v, want the status error", err)
	}
	// The mutation itself ran: the argv log shows the add with its pathspec
	// plumbing and NO path in argv (D8).
	calls := fakeGitLog(t, env)
	found := false
	for _, call := range calls {
		if len(call) == 3 && call[0] == "add" && call[1] == "--pathspec-from-file=-" && call[2] == "--pathspec-file-nul" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the add invocation never ran: %v", calls)
	}
}

// TestMutationFails: the mutation itself failing is an error carrying git's
// account.
func TestMutationFails(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_MUTATE": "fail"})
	repo := openRepo(t, env, t.TempDir())

	_, err := repo.Stage(context.Background(), []string{"f.txt"})
	if err == nil || !strings.Contains(err.Error(), "index.lock") {
		t.Fatalf("Stage returned %v, want the git error", err)
	}
}

// TestNoPathInMutationArgv: paths ride on stdin, never in argv — a path
// beginning with '-' is not an option, and there is no OS argv length cap.
func TestNoPathInMutationArgv(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_MUTATE": "ok"})
	repo := openRepo(t, env, t.TempDir())

	weird := []string{"-leading-dash.txt", "with space.txt"}
	if _, err := repo.Stage(context.Background(), weird); err != nil {
		t.Fatal(err)
	}
	for _, call := range fakeGitLog(t, env) {
		for _, arg := range call {
			if arg == "-leading-dash.txt" || arg == "with space.txt" {
				t.Fatalf("path %q appeared in argv: %v", arg, call)
			}
		}
	}
}

// TestCommitMessageOnStdin: the message never rides in argv.
func TestCommitMessageOnStdin(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_COMMIT": "ok", "FAKE_STATUS": "staged"})
	repo := openRepo(t, env, t.TempDir())

	msg := "subject with 'quotes' and \"double\" and\nnewlines"
	if _, err := repo.Commit(context.Background(), msg, false); err != nil {
		t.Fatal(err)
	}
	for _, call := range fakeGitLog(t, env) {
		if len(call) > 0 && call[0] == "commit" {
			for _, arg := range call {
				if strings.Contains(arg, "quotes") {
					t.Fatalf("message leaked into argv: %v", call)
				}
			}
		}
	}
}

func TestHeadMessageNoneOnUnborn(t *testing.T) {
	dir := newGitRepo(t)
	repo := openRepo(t, gitEnv(t), dir)
	hm, err := repo.HeadMessage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if hm.State != git.HeadMessageNone {
		t.Fatalf("State = %s, want none on an unborn branch", hm.State)
	}
}

// conflictedRepo builds a repository in a conflicted merge state.
func conflictedRepo(t *testing.T) string {
	t.Helper()
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "base\n")
	gitCommit(t, dir, "base")
	cmd := commandIn(dir, "checkout", "-q", "-b", "topic")
	cmd.Env = gitEnv(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("checkout -b: %v: %s", err, out)
	}
	gitWrite(t, dir, "f.txt", "topic\n")
	gitCommit(t, dir, "topic")
	cmd = commandIn(dir, "checkout", "-q", "master")
	cmd.Env = gitEnv(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("checkout master: %v: %s", err, out)
	}
	gitWrite(t, dir, "f.txt", "master\n")
	gitCommit(t, dir, "master")
	cmd = commandIn(dir, "merge", "topic")
	cmd.Env = gitEnv(t)
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("merge unexpectedly succeeded: %s", out)
	}
	return dir
}

func assertStillConflicted(t *testing.T, dir string) {
	t.Helper()
	// The refusal must leave the merge exactly as it was: MERGE_HEAD still
	// present, and the record still a conflict.
	if _, err := os.Stat(filepath.Join(dir, ".git", "MERGE_HEAD")); err != nil {
		t.Fatalf("MERGE_HEAD gone after a refused unstage-all: %v", err)
	}
	cmd := commandIn(dir, "status", "--porcelain=v1")
	cmd.Env = gitEnv(t)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(out), "UU ") {
		t.Fatalf("conflicted record changed after a refused stage-all: %q", out)
	}
}

func TestUnstageFails(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_MUTATE": "fail"})
	repo := openRepo(t, env, t.TempDir())
	_, err := repo.Unstage(context.Background(), []string{"f.txt"})
	if err == nil || !strings.Contains(err.Error(), "index.lock") {
		t.Fatalf("Unstage returned %v, want the git error", err)
	}
}

func TestStageAllFails(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_MUTATE": "fail"})
	repo := openRepo(t, env, t.TempDir())
	_, err := repo.StageAll(context.Background())
	if err == nil || !strings.Contains(err.Error(), "index.lock") {
		t.Fatalf("StageAll returned %v, want the git error", err)
	}
}

func TestUnstageAllFails(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_MUTATE": "fail"})
	repo := openRepo(t, env, t.TempDir())
	_, err := repo.UnstageAll(context.Background())
	if err == nil || !strings.Contains(err.Error(), "index.lock") {
		t.Fatalf("UnstageAll returned %v, want the git error", err)
	}
}
