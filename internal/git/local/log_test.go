package local

// Log tests (brief, git.log; D9): the bounded read on an ordinary
// repository succeeds (paired with every failure below), an unborn branch
// is an empty list rather than a failure, a non-unborn failure propagates,
// the cap is reported rather than implied, a stream cut mid-record is cut,
// and a subject containing a newline and a tab survives. The failures run
// against the fake git; the successes run against the real git.

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/git"
)

// TestLogSucceedsOnAnOrdinaryRepository is the paired "and on a normal
// machine it succeeds": two commits, newest first, refs from the branch.
func TestLogSucceedsOnAnOrdinaryRepository(t *testing.T) {
	env := gitEnv(t)
	dir := newGitRepo(t)
	gitWrite(t, dir, "a.txt", "a\n")
	gitCommit(t, dir, "first")
	gitWrite(t, dir, "b.txt", "b\n")
	gitCommit(t, dir, "second")

	repo := openRepo(t, env, dir)
	lg, err := repo.Log(context.Background(), 50)
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if lg.Completeness != git.CompletenessComplete {
		t.Fatalf("Completeness = %s, want complete", lg.Completeness)
	}
	if lg.Total != 2 {
		t.Fatalf("Total = %d, want 2", lg.Total)
	}
	if lg.Entries[0].Subject != "second" || lg.Entries[1].Subject != "first" {
		t.Fatalf("entries not newest-first: %+v", lg.Entries)
	}
	if lg.Entries[0].ShortHash == "" || lg.Entries[0].Hash == "" {
		t.Fatal("hashes empty")
	}
	if lg.Entries[0].AuthoredAt.IsZero() {
		t.Fatal("authored time zero")
	}
	if len(lg.Entries[0].Refs) == 0 {
		t.Fatalf("HEAD commit carries no refs: %+v", lg.Entries[0])
	}
}

// TestLogOnUnbornBranchIsEmptyNotBroken — git log exits 128 with a prose
// account; the honest log of a branch with no commits is empty, and the
// unborn fact is Status's to report (D7), never a prose classification
// (D11). The fake's status answers an unborn branch.
func TestLogOnUnbornBranchIsEmptyNotBroken(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_LOG_MODE": "unborn",
		"FAKE_STATUS":   "staged", // # branch.oid (initial) → Unborn
	})
	repo := openRepo(t, env, t.TempDir())
	lg, err := repo.Log(context.Background(), 50)
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if lg.Completeness != git.CompletenessComplete {
		t.Fatalf("Completeness = %s, want complete", lg.Completeness)
	}
	if lg.Total != 0 || len(lg.Entries) != 0 {
		t.Fatalf("unborn log = %d entries, want none", len(lg.Entries))
	}
}

// TestLogNonUnbornFailurePropagates — a non-zero exit that is not the
// unborn state is a real failure: the panel must not render a broken
// repository as an empty list.
func TestLogNonUnbornFailurePropagates(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_LOG_MODE": "fail",
		"FAKE_STATUS":   "finite", // a real (non-unborn) branch — status succeeds
	})
	repo := openRepo(t, env, t.TempDir())
	_, err := repo.Log(context.Background(), 50)
	if err == nil {
		t.Fatal("Log succeeded on a failing git")
	}
	if !strings.Contains(err.Error(), "exit 128") {
		t.Fatalf("error does not carry git's account: %v", err)
	}
}

// TestLogCappedReportsMoreThanMax — the invocation asks for max+1 and the
// extra record is the proof that more exist (D9).
func TestLogCappedReportsMoreThanMax(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_LOG_MODE": "two"})
	repo := openRepo(t, env, t.TempDir())
	lg, err := repo.Log(context.Background(), 1)
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if lg.Completeness != git.CompletenessCapped {
		t.Fatalf("Completeness = %s, want capped", lg.Completeness)
	}
	if lg.Total != 2 {
		t.Fatalf("Total = %d, want 2 (max+1 — the extra record)", lg.Total)
	}
	if len(lg.Entries) != 1 {
		t.Fatalf("retained %d entries, want 1", len(lg.Entries))
	}
}

// TestLogCutAtByteCeiling — the byte half of the work ceiling stops the
// stream mid-record; the answer is cut with a lower bound, never a
// silently truncated list that looks complete.
func TestLogCutAtByteCeiling(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_LOG_MODE": "stream"})
	repo := openRepo(t, env, t.TempDir(), WithLogCeilings(256, time.Minute))
	lg, err := repo.Log(context.Background(), 50)
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if lg.Completeness != git.CompletenessCut {
		t.Fatalf("Completeness = %s, want cut", lg.Completeness)
	}
	if lg.Total <= 0 {
		t.Fatalf("Total = %d, want a positive lower bound", lg.Total)
	}
}

// TestLogCutMidRecordReported — a stream that ends inside a record (the
// parser's half of the cut) is reported as cut, not as a clean end.
func TestLogCutMidRecordReported(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_LOG_MODE": "truncated"})
	repo := openRepo(t, env, t.TempDir())
	lg, err := repo.Log(context.Background(), 50)
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if lg.Completeness != git.CompletenessCut {
		t.Fatalf("Completeness = %s, want cut", lg.Completeness)
	}
	if lg.Total != 1 {
		t.Fatalf("Total = %d, want 1 — only the complete record counts", lg.Total)
	}
}

// TestLogSubjectWithNewlineAndTab — a subject may contain a tab (and a
// newline); the NUL-delimited parser is what keeps it one field.
func TestLogSubjectWithNewlineAndTab(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_LOG_MODE": "newline"})
	repo := openRepo(t, env, t.TempDir())
	lg, err := repo.Log(context.Background(), 50)
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if lg.Entries[0].Subject != "sub\tject" {
		t.Fatalf("Subject = %q, want %q", lg.Entries[0].Subject, "sub\tject")
	}
}

// TestLogCommitWithNoRefs — a commit with no decorations parses with an
// empty refs set, and the record after it stays aligned.
func TestLogCommitWithNoRefs(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_LOG_MODE": "two"})
	repo := openRepo(t, env, t.TempDir())
	lg, err := repo.Log(context.Background(), 50)
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if len(lg.Entries[0].Refs) != 1 || lg.Entries[0].Refs[0] != "main" {
		t.Fatalf("first entry Refs = %v", lg.Entries[0].Refs)
	}
	if lg.Entries[1].Refs == nil || len(lg.Entries[1].Refs) != 0 {
		t.Fatalf("no-refs entry Refs = %v, want []", lg.Entries[1].Refs)
	}
}

// TestLogDetachedHeadWorks — a detached HEAD logs fine, and the refs say
// HEAD out loud.
func TestLogDetachedHeadWorks(t *testing.T) {
	env := gitEnv(t)
	dir := newGitRepo(t)
	gitWrite(t, dir, "a.txt", "a\n")
	gitCommit(t, dir, "only")
	if err := commandIn(dir, "checkout", "-q", "--detach").Run(); err != nil {
		t.Fatal(err)
	}

	repo := openRepo(t, env, dir)
	lg, err := repo.Log(context.Background(), 50)
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if lg.Total != 1 {
		t.Fatalf("Total = %d, want 1", lg.Total)
	}
	foundHead := false
	for _, ref := range lg.Entries[0].Refs {
		if ref == "HEAD" {
			foundHead = true
		}
	}
	if !foundHead {
		t.Fatalf("detached HEAD refs = %v, want HEAD among them", lg.Entries[0].Refs)
	}
}

// TestLogShallowCloneReturnsWhatItHas — a shallow clone has exactly what it
// has; the answer is complete, not an error.
func TestLogShallowCloneReturnsWhatItHas(t *testing.T) {
	env := gitEnv(t)
	src := newGitRepo(t)
	gitWrite(t, src, "a.txt", "a\n")
	gitCommit(t, src, "one")
	gitWrite(t, src, "b.txt", "b\n")
	gitCommit(t, src, "two")
	dst := t.TempDir()
	if err := commandIn(src, "clone", "-q", "--depth", "1", "file://"+src, dst).Run(); err != nil {
		t.Fatal(err)
	}

	repo := openRepo(t, env, dst)
	lg, err := repo.Log(context.Background(), 50)
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if lg.Completeness != git.CompletenessComplete {
		t.Fatalf("Completeness = %s, want complete", lg.Completeness)
	}
	if lg.Total != 1 || lg.Entries[0].Subject != "two" {
		t.Fatalf("shallow log = %+v, want the one commit the clone has", lg)
	}
}

func TestLogRequiresPositiveBound(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{"FAKE_LOG_MODE": "one"})
	repo := openRepo(t, env, t.TempDir())
	if _, err := repo.Log(context.Background(), 0); err == nil {
		t.Fatal("Log accepted a non-positive bound")
	}
}
