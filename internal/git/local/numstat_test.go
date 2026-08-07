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

// ── the counts on real repositories ───────────────────────────────────────
//
// Every case below runs the REAL git: the counts are git's own numstat
// answer, through the whole read path. The fake-git cases at the bottom
// cover what real git cannot be asked to do cheaply (a failing numstat, a
// bounded-out stream, an argv contract).

// TestNumstatCountsOnModifiedFile is the acceptance shape at the domain
// level, and the paired assertion every "no count" case below is paired
// with: an ordinary modified file returns its count. A file that gained
// three lines and lost one reads +3 −1.
func TestNumstatCountsOnModifiedFile(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "a\nb\nc\nd\n")
	gitCommit(t, dir, "one")
	if err := writeFile(dir+"/f.txt", "a\nx\nb\nc\ny\nz\n", 0o600); err != nil {
		t.Fatal(err)
	}
	repo := openRepo(t, gitEnv(t), dir)

	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Unstaged) != 1 || st.Unstaged[0].Path != "f.txt" {
		t.Fatalf("Unstaged = %+v", st.Unstaged)
	}
	e := st.Unstaged[0]
	if e.Added == nil || e.Deleted == nil {
		t.Fatalf("f.txt has no counts: %+v", e)
	}
	if *e.Added != 3 || *e.Deleted != 1 {
		t.Fatalf("counts = +%d −%d, want +3 −1", *e.Added, *e.Deleted)
	}
}

// TestNumstatCountsOnStagedFile: the index side is counted from --cached.
func TestNumstatCountsOnStagedFile(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "a\nb\nc\nd\n")
	gitCommit(t, dir, "one")
	gitWrite(t, dir, "f.txt", "a\nx\nb\nc\ny\nz\n")
	repo := openRepo(t, gitEnv(t), dir)

	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Staged) != 1 || st.Staged[0].Path != "f.txt" {
		t.Fatalf("Staged = %+v", st.Staged)
	}
	e := st.Staged[0]
	if e.Added == nil || e.Deleted == nil {
		t.Fatalf("staged f.txt has no counts: %+v", e)
	}
	if *e.Added != 3 || *e.Deleted != 1 {
		t.Fatalf("counts = +%d −%d, want +3 −1", *e.Added, *e.Deleted)
	}
}

// TestNumstatCountsBothLists: a file staged AND edited again lands in both
// lists, and each side carries its own diff's counts — the index side vs
// HEAD, the worktree side vs the index.
func TestNumstatCountsBothLists(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "v1\nv2\nv3\n")
	gitCommit(t, dir, "one")
	gitWrite(t, dir, "f.txt", "v1\nv2\nv3\nA\nB\n") // staged: +2 −0
	if err := writeFile(dir+"/f.txt", "v1\nv2\nv3\nA\nB\nC\nD\n", 0o600); err != nil {
		t.Fatal(err)
	}
	repo := openRepo(t, gitEnv(t), dir)

	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Staged) != 1 || len(st.Unstaged) != 1 {
		t.Fatalf("one file in both lists: %s", summary(st))
	}
	staged, unstaged := st.Staged[0], st.Unstaged[0]
	if staged.Added == nil || staged.Deleted == nil || unstaged.Added == nil || unstaged.Deleted == nil {
		t.Fatalf("counts missing: staged %+v unstaged %+v", staged, unstaged)
	}
	if *staged.Added != 2 || *staged.Deleted != 0 {
		t.Fatalf("staged counts = +%d −%d, want +2 −0", *staged.Added, *staged.Deleted)
	}
	if *unstaged.Added != 2 || *unstaged.Deleted != 0 {
		t.Fatalf("unstaged counts = +%d −%d, want +2 −0", *unstaged.Added, *unstaged.Deleted)
	}
}

// TestNumstatNoCountsForUntracked: an untracked file has no counts — a
// numstat per untracked file is one git process per file, and the 761-file
// case is exactly what the work ceiling exists for. The refusal is
// deliberate; the paired case is the modified file above.
func TestNumstatNoCountsForUntracked(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "hi")
	gitCommit(t, dir, "one")
	if err := writeFile(dir+"/new.txt", "fresh\n", 0o600); err != nil {
		t.Fatal(err)
	}
	repo := openRepo(t, gitEnv(t), dir)

	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var untracked *git.Entry
	for i := range st.Unstaged {
		if st.Unstaged[i].Path == "new.txt" {
			untracked = &st.Unstaged[i]
		}
	}
	if untracked == nil {
		t.Fatalf("new.txt not in Unstaged: %s", summary(st))
	}
	if untracked.Added != nil || untracked.Deleted != nil {
		t.Fatalf("untracked new.txt carries counts: %+v", untracked)
	}
}

// TestNumstatNoCountsForBinary: git prints '-' for both columns of a binary
// file — "no line count exists", not zero — and the entry must not render
// +0 −0.
func TestNumstatNoCountsForBinary(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "hello\n")
	gitCommit(t, dir, "one")
	if err := os.WriteFile(dir+"/f.txt", []byte{0x00, 0x01, 0x02, 0xff, 0x00}, 0o600); err != nil {
		t.Fatal(err)
	}
	repo := openRepo(t, gitEnv(t), dir)

	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Unstaged) != 1 || st.Unstaged[0].Path != "f.txt" {
		t.Fatalf("Unstaged = %+v", st.Unstaged)
	}
	e := st.Unstaged[0]
	if e.Added != nil || e.Deleted != nil {
		t.Fatalf("binary f.txt carries counts: %+v", e)
	}
}

// TestNumstatCountsOnRename: a staged rename emits the three-field numstat
// record (measured on git 2.55: counts header with an empty path, then the
// FROM path, then the TO path). The counts belong to the TO path — the
// current path, the one the status entry names.
func TestNumstatCountsOnRename(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "old.txt", "one\ntwo\nthree\n")
	gitCommit(t, dir, "one")
	cmd := commandIn(dir, "mv", "old.txt", "new.txt")
	cmd.Env = gitEnv(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git mv: %v: %s", err, out)
	}
	repo := openRepo(t, gitEnv(t), dir)

	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Staged) != 1 || st.Staged[0].Path != "new.txt" {
		t.Fatalf("Staged = %+v (want the rename's current path)", st.Staged)
	}
	e := st.Staged[0]
	if e.Added == nil || e.Deleted == nil {
		t.Fatalf("renamed new.txt has no counts: %+v", e)
	}
	// A pure rename moves three unchanged lines: 0 added, 0 deleted is
	// git's answer — present counts, not absent ones.
	if *e.Added != 0 || *e.Deleted != 0 {
		t.Fatalf("rename counts = +%d −%d, want +0 −0", *e.Added, *e.Deleted)
	}
}

// TestNumstatCountsOnUnbornStaged: on an unborn branch git diff --cached
// diffs against the empty tree (measured: exit 0, real counts), so a staged
// file on an unborn branch carries its counts like any other.
func TestNumstatCountsOnUnbornStaged(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "one\ntwo\n")
	repo := openRepo(t, gitEnv(t), dir)

	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !st.Unborn || len(st.Staged) != 1 {
		t.Fatalf("want unborn with one staged file: %s", summary(st))
	}
	e := st.Staged[0]
	if e.Added == nil || e.Deleted == nil {
		t.Fatalf("unborn staged file has no counts: %+v", e)
	}
	if *e.Added != 2 || *e.Deleted != 0 {
		t.Fatalf("counts = +%d −%d, want +2 −0", *e.Added, *e.Deleted)
	}
}

// TestNumstatNoCountsForConflicted: during a merge git diff reports several
// diff pairs for one unmerged path (measured: two records for one conflicted
// file), none of which is THE line count of the file the row names, so a
// conflicted entry carries no counts. The merge keys on the lists, and the
// conflicted list is untouched.
func TestNumstatNoCountsForConflicted(t *testing.T) {
	dir := newGitRepo(t)
	gitWrite(t, dir, "f.txt", "base\n")
	gitCommit(t, dir, "base")

	cmd := commandIn(dir, "checkout", "-q", "-b", "side")
	cmd.Env = gitEnv(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("checkout -b: %v: %s", err, out)
	}
	gitWrite(t, dir, "f.txt", "side\n")
	gitCommit(t, dir, "side")

	cmd = commandIn(dir, "checkout", "-q", "master")
	cmd.Env = gitEnv(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("checkout master: %v: %s", err, out)
	}
	gitWrite(t, dir, "f.txt", "main\n")
	gitCommit(t, dir, "main")

	cmd = commandIn(dir, "merge", "side")
	cmd.Env = gitEnv(t)
	if out := cmd.Run(); out == nil {
		t.Fatal("merge succeeded; the fixture needs a conflict")
	}

	repo := openRepo(t, gitEnv(t), dir)
	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Conflicted) != 1 || st.Conflicted[0].Path != "f.txt" {
		t.Fatalf("Conflicted = %+v", st.Conflicted)
	}
	e := st.Conflicted[0]
	if e.Added != nil || e.Deleted != nil {
		t.Fatalf("conflicted f.txt carries counts: %+v", e)
	}
	if len(st.Staged) != 0 || len(st.Unstaged) != 0 {
		t.Fatalf("a conflicted file must not land in the lists: %s", summary(st))
	}
}

// ── the degraded and contract cases, through the fake git ─────────────────

// numstatStreamFile writes a numstat stream to a scratch file and returns
// the path for a FAKE_NUMSTAT_*_FILE env value. The streams ride in files
// because a numstat record is NUL-terminated and an env value may not
// contain a NUL byte.
func numstatStreamFile(t *testing.T, stream string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "numstat.bin")
	if err := os.WriteFile(p, []byte(stream), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestNumstatFailureDegradesToCut: git diff --numstat exits non-zero — the
// primary read succeeded, so the status is still returned, but no entry
// carries counts and Completeness is cut: the panel's one visible
// "the answer is incomplete" state. A failing enrichment read must not
// destroy the status it enriches, and must not silently look complete.
func TestNumstatFailureDegradesToCut(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_STATUS":  "staged",
		"FAKE_NUMSTAT": "fail",
	})
	repo := openRepo(t, env, t.TempDir())

	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.Completeness != git.CompletenessCut {
		t.Fatalf("Completeness = %s, want cut", st.Completeness)
	}
	if len(st.Staged) != 1 {
		t.Fatalf("the lists must survive a failed count read: %s", summary(st))
	}
	if st.Staged[0].Added != nil || st.Staged[0].Deleted != nil {
		t.Fatalf("a degraded read must attach no counts: %+v", st.Staged[0])
	}
}

// TestNumstatCutDegradesToCut: the numstat stream hits the byte ceiling —
// bounded by the same budget as the status read (design D9) — and the
// answer degrades the same way: no counts anywhere, Completeness cut. A
// partial count set would make the rows past the cut look like rows with
// nothing to count, which is the D9 lie.
func TestNumstatCutDegradesToCut(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_STATUS":  "staged",
		"FAKE_NUMSTAT": "stream",
	})
	repo := openRepo(t, env, t.TempDir(), WithStatusCeilings(1024, 10*time.Second))

	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.Completeness != git.CompletenessCut {
		t.Fatalf("Completeness = %s, want cut", st.Completeness)
	}
	if st.Staged[0].Added != nil || st.Staged[0].Deleted != nil {
		t.Fatalf("a bounded count read must attach no counts: %+v", st.Staged[0])
	}
}

// TestStatusCutSkipsNumstat: when the STATUS traversal itself is cut, no
// count read runs at all — two more full-repository diffs are exactly the
// work the ceiling exists to bound, and counts on a lower-bound prefix
// would look authoritative. Asserted on the argv log: only status was
// asked.
func TestStatusCutSkipsNumstat(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_STATUS":  "stream",
		"FAKE_NUMSTAT": "fail", // would fail loudly if it were invoked
	})
	repo := openRepo(t, env, t.TempDir(), WithStatusCeilings(1024, 10*time.Second))

	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.Completeness != git.CompletenessCut {
		t.Fatalf("Completeness = %s, want cut", st.Completeness)
	}
	for _, call := range fakeGitLog(t, env) {
		if len(call) > 0 && call[0] == "diff" {
			t.Fatalf("a cut status must not run count reads, saw diff %v", call)
		}
	}
}

// TestNumstatDisagreement: the numstat stream and the status stream are two
// reads of a moving repository, so a path can be in one and not the other.
// What is true is decided here and asserted: the STATUS entries are the
// rows, so a numstat path with no status entry is dropped, and a status
// entry with no numstat record gets no counts.
func TestNumstatDisagreement(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_STATUS":                "staged", // status: staged f.txt
		"FAKE_NUMSTAT_CACHED_FILE":   numstatStreamFile(t, "2\t0\tf.txt\x00"+"5\t5\tghost.txt\x00"),
		"FAKE_NUMSTAT_WORKTREE_FILE": numstatStreamFile(t, ""),
	})
	repo := openRepo(t, env, t.TempDir())

	st, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.Completeness != git.CompletenessComplete {
		t.Fatalf("Completeness = %s, want complete", st.Completeness)
	}
	if len(st.Staged) != 1 {
		t.Fatalf("Staged = %+v", st.Staged)
	}
	e := st.Staged[0]
	if e.Path != "f.txt" || e.Added == nil || *e.Added != 2 {
		t.Fatalf("f.txt counts = %+v, want +2", e)
	}
	// ghost.txt has no status entry and must not invent one.
	for _, list := range [][]git.Entry{st.Staged, st.Unstaged, st.Conflicted} {
		for _, entry := range list {
			if entry.Path == "ghost.txt" {
				t.Fatalf("numstat-only path became a row: %s", summary(st))
			}
		}
	}
}

// TestNumstatEnvAndArgv pins the invocation contract: git diff [--cached]
// --numstat -z --no-ext-diff, with GIT_OPTIONAL_LOCKS=0 — StatusArgs'
// --no-optional-locks decision carried onto a command that rejects the
// flag, so the panel's reads never rewrite .git/index (brief nocx-i4ki).
func TestNumstatEnvAndArgv(t *testing.T) {
	env := fakeGitEnv(t, map[string]string{
		"FAKE_STATUS":                "staged",
		"FAKE_NUMSTAT_CACHED_FILE":   numstatStreamFile(t, "2\t0\tf.txt\x00"),
		"FAKE_NUMSTAT_WORKTREE_FILE": numstatStreamFile(t, "1\t1\tf.txt\x00"),
	})
	repo := openRepo(t, env, t.TempDir())

	if _, err := repo.Status(context.Background()); err != nil {
		t.Fatal(err)
	}
	var cached, worktree int
	for _, call := range fakeGitLog(t, env) {
		if len(call) == 0 || call[0] != "diff" {
			continue
		}
		joined := strings.Join(call, " ")
		if strings.Contains(joined, "--cached") {
			cached++
			if !strings.Contains(joined, "--numstat -z --no-ext-diff") {
				t.Fatalf("cached numstat argv = %v", call)
			}
		} else {
			worktree++
			if !strings.Contains(joined, "--numstat -z --no-ext-diff") {
				t.Fatalf("worktree numstat argv = %v", call)
			}
		}
	}
	if cached != 1 || worktree != 1 {
		t.Fatalf("numstat invocations: cached=%d worktree=%d, want 1 each", cached, worktree)
	}
	// The lock-safety knob: the fake records GIT_OPTIONAL_LOCKS for every
	// numstat invocation in a dedicated log (the argv log cannot carry it —
	// a marker there would land in the next entry across the blank
	// separator).
	envLog := ""
	for _, kv := range env {
		if strings.HasPrefix(kv, "FAKE_GIT_LOG_ENV=") {
			envLog = strings.TrimPrefix(kv, "FAKE_GIT_LOG_ENV=")
		}
	}
	data, err := os.ReadFile(envLog)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(data)); got != "0\n0" {
		t.Fatalf("GIT_OPTIONAL_LOCKS log = %q, want two 0s (one per read)", got)
	}
}
