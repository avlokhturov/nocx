package local

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/git"
)

// writeFakeGit installs a git(1) test double in a fresh directory and
// returns that directory. The double records every invocation's argv, one
// argument per line followed by a blank separator line, to $FAKE_GIT_LOG,
// and dispatches on its first argument; every behavior is driven by
// environment variables so one script serves the whole suite:
//
//	FAKE_GIT_VERSION  the --version answer (default 2.55.0)
//	FAKE_REVPARSE     rev-parse answer; the literal "FAIL" exits 128
//	FAKE_TOPLEVEL     the two-line rev-parse answer, line 1
//	FAKE_GITDIR       line 2
//	FAKE_HEAD         rev-parse --short HEAD answer; "FAIL" exits 128
//	FAKE_LOG          headMessage answer
//	FAKE_DIFF         sleep | sleep_stubborn | fail
//	FAKE_NUMSTAT      mode for `git diff --numstat`: fail | stream | otherwise
//	                  the stream comes from FAKE_NUMSTAT_CACHED_FILE /
//	                  FAKE_NUMSTAT_WORKTREE_FILE (absent: a valid numstat
//	                  answer with no counts). The streams live in files
//	                  because a numstat record is NUL-terminated and an env
//	                  value may not contain a NUL.
func writeFakeGit(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "git")
	body := `#!/bin/sh
printf '%s\n' "$@" >> "$FAKE_GIT_LOG"
printf '\n' >> "$FAKE_GIT_LOG"
# Real git accepts git-level options BEFORE the subcommand, and the reader
# uses one: --no-optional-locks, so that polling never rewrites .git/index.
# Skip them here for the same reason, or this fake dispatches on a flag and
# every status test silently exercises the fallthrough instead of status.
# --version is itself a git-level option and stays dispatched below.
while [ $# -gt 0 ]; do
  case "$1" in
    --version) break ;;
    --*) shift ;;
    *) break ;;
  esac
done
case "$1" in
  --version)
    echo "git version ${FAKE_GIT_VERSION:-2.55.0}"
    exit 0 ;;
  rev-parse)
    if [ "$2" = "--short" ]; then
      if [ "${FAKE_HEAD:-}" = "FAIL" ]; then
        echo "fatal: bad revision 'HEAD'" >&2
        exit 128
      fi
      echo "${FAKE_HEAD:-abc1234}"
      exit 0
    fi
    if [ "${FAKE_REVPARSE:-}" = "FAIL" ]; then
      echo "fatal: not a git repository" >&2
      exit 128
    fi
    if [ -n "${FAKE_REVPARSE:-}" ]; then
      printf '%s' "$FAKE_REVPARSE"
      exit 0
    fi
    echo "${FAKE_TOPLEVEL:-/tmp/fake}"
    echo "${FAKE_GITDIR:-/tmp/fake/.git}"
    exit 0 ;;
  status)
    case "${FAKE_STATUS:-none}" in
      stream)
        i=0
        while true; do
          printf '1 M. N... 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 f%06d\000' "$i"
          i=$((i+1))
        done ;;
      finite)
        i=0
        while [ "$i" -lt 100 ]; do
          printf '1 M. N... 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 f%06d\000' "$i"
          i=$((i+1))
        done
        exit 0 ;;
      staged)
        printf '# branch.oid (initial)\000# branch.head master\0001 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 f.txt\000'
        exit 0 ;;
      staged_then_fail)
        n=0
        if [ -f "$FAKE_GIT_COUNT" ]; then n=$(cat "$FAKE_GIT_COUNT"); fi
        n=$((n+1))
        echo "$n" > "$FAKE_GIT_COUNT"
        if [ "$n" -eq 1 ]; then
          printf '# branch.oid (initial)\000# branch.head master\0001 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 f.txt\000'
          exit 0
        fi
        echo "fatal: index corrupt" >&2
        exit 1 ;;
      sleep)
        sleep 1000 ;;
      sleep_stubborn)
        trap '' INT TERM
        sleep 1000 ;;
      fail)
        echo "fatal: index corrupt" >&2
        exit 1 ;;
      flood)
        i=0
        while [ "$i" -lt 6000 ]; do
          echo "hook noise line $i" >&2
          i=$((i+1))
        done
        exit 1 ;;
      *) exit 0 ;;
    esac ;;
  add|reset)
    case "${FAKE_MUTATE:-fail}" in
      fail) echo "fatal: index.lock exists" >&2; exit 128 ;;
      *) exit 0 ;;
    esac ;;
  commit)
    case "${FAKE_COMMIT:-ok}" in
      fail)
        echo "error: pre-commit hook declined" >&2
        exit 1 ;;
      fail_flood)
        i=0
        while [ "$i" -lt 6000 ]; do
          echo "hook noise $i" >&2
          i=$((i+1))
        done
        echo "error: hook failed" >&2
        exit 1 ;;
      *) echo "[main abc1234] msg" >&2; exit 0 ;;
    esac ;;
  log)
    printf '%s' "${FAKE_LOG:-subject line\n\nbody text}"
    exit 0 ;;
  diff)
    if [ -n "${FAKE_NUMSTAT:-}" ] || [ -n "${FAKE_NUMSTAT_CACHED_FILE:-}" ] || [ -n "${FAKE_NUMSTAT_WORKTREE_FILE:-}" ]; then
      case "${FAKE_NUMSTAT:-ok}" in
        fail) echo "fatal: index corrupt" >&2; exit 128 ;;
        stream) i=0; while true; do printf '1\t0\tf%06d\000' "$i"; i=$((i+1)); done ;;
        *)
          # The invocation environment is otherwise unobservable from the
          # argv log; this line records the lock-safety knob (the env form
          # of status' --no-optional-locks, which git diff rejects).
          printf '%s\n' "${GIT_OPTIONAL_LOCKS:-unset}" >> "$FAKE_GIT_LOG_ENV"
          # The streams ride in files, never env vars: an env value may not
          # contain a NUL byte, and the numstat records are NUL-terminated.
          if [ "$2" = "--cached" ]; then
            if [ -n "${FAKE_NUMSTAT_CACHED_FILE:-}" ]; then cat "$FAKE_NUMSTAT_CACHED_FILE"; fi
          else
            if [ -n "${FAKE_NUMSTAT_WORKTREE_FILE:-}" ]; then cat "$FAKE_NUMSTAT_WORKTREE_FILE"; fi
          fi
          exit 0 ;;
      esac
    fi
    case "${FAKE_DIFF:-none}" in
      sleep) sleep 1000 ;;
      sleep_stubborn) trap '' INT TERM; sleep 1000 ;;
      fail) echo "fatal: bad config" >&2; exit 128 ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
`
	// #nosec G306 — the fake git must be executable: fakeGitEnv puts its dir on PATH and the factory LookPaths it.
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// fakeGitEnv builds an environment whose PATH resolves to the fake git, plus
// the behavior overrides. It points HOME at a scratch dir, and answers
// rev-parse with a REAL scratch directory: the Repo executes every command
// with that directory as its cwd, and a cwd that does not exist fails at
// exec time, not with a git error.
func fakeGitEnv(t *testing.T, behaviors map[string]string) []string {
	t.Helper()
	dir := writeFakeGit(t)
	home := t.TempDir()
	repo := t.TempDir()
	env := []string{
		"PATH=" + dir + ":" + os.Getenv("PATH"),
		"FAKE_GIT_LOG=" + filepath.Join(dir, "argv.log"),
		"FAKE_GIT_LOG_ENV=" + filepath.Join(dir, "env.log"),
		"FAKE_GIT_COUNT=" + filepath.Join(dir, "count"),
		"HOME=" + home,
		"FAKE_TOPLEVEL=" + repo,
		"FAKE_GITDIR=" + filepath.Join(repo, ".git"),
	}
	for k, v := range behaviors {
		env = append(env, k+"="+v)
	}
	return env
}

// fakeGitLog returns the argv the fake git recorded, one entry per
// invocation, each entry a slice of its arguments.
func fakeGitLog(t *testing.T, env []string) [][]string {
	t.Helper()
	var path string
	for _, kv := range env {
		if strings.HasPrefix(kv, "FAKE_GIT_LOG=") {
			path = strings.TrimPrefix(kv, "FAKE_GIT_LOG=")
		}
	}
	data, err := os.ReadFile(path) // #nosec G304 — path is the test's own scratch log (FAKE_GIT_LOG, under t.TempDir()), written by the fake git
	if err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	var cur []string
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		if line == "" {
			if len(cur) > 0 {
				calls = append(calls, cur)
				cur = nil
			}
			continue
		}
		cur = append(cur, line)
	}
	if len(cur) > 0 {
		calls = append(calls, cur)
	}
	return calls
}

// realGitPath finds the machine's real git for the end-to-end tests.
func realGitPath(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("git")
	if err != nil {
		t.Skipf("git not installed: %v", err)
	}
	return p
}

// gitEnv builds an environment that runs the real git: the real git's
// directory first on PATH, a scratch HOME with a configured identity, and
// prompts off. LANG is pinned so output is byte-stable.
func gitEnv(t *testing.T) []string {
	t.Helper()
	p := realGitPath(t)
	home := t.TempDir()
	cfg := "[user]\n\tname = Test User\n\temail = test@nocx.invalid\n[init]\n\tdefaultBranch = master\n[commit]\n\tgpgsign = false\n"
	if err := os.WriteFile(filepath.Join(home, ".gitconfig"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	return []string{
		"PATH=" + filepath.Dir(p) + ":" + os.Getenv("PATH"),
		"HOME=" + home,
		"LANG=C",
		"LC_ALL=C",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_NOSYSTEM=1",
	}
}

// newGitRepo creates a real git repository (no commits) and returns its path.
func newGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cmd := exec.Command(realGitPath(t), "init", "-q", dir) // #nosec G204 — realGitPath is LookPath-resolved (skips if absent); args are fixed literals plus a t.TempDir() path
	cmd.Env = gitEnv(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	return dir
}

// openRepo opens cwd through a factory built with the given env, failing the
// test unless the outcome is ok.
func openRepo(t *testing.T, env []string, cwd string, opts ...Option) git.Repo {
	t.Helper()
	f := NewFactory(append([]Option{WithEnv(env)}, opts...)...)
	repo, outcome, err := f.Open(context.Background(), cwd)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if outcome.State != git.OpenOK {
		t.Fatalf("Open outcome = %s (want ok)", outcome.State)
	}
	if repo == nil {
		t.Fatal("ok outcome with a nil repo")
	}
	return repo
}

// gitCommit commits every staged change in dir with the given message.
func gitCommit(t *testing.T, dir, msg string) {
	t.Helper()
	cmd := exec.Command(realGitPath(t), "commit", "-m", msg) // #nosec G204 — realGitPath is LookPath-resolved; msg is a test literal
	cmd.Dir = dir
	cmd.Env = gitEnv(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v: %s", err, out)
	}
}

// gitWrite writes a file and stages it.
func gitWrite(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(realGitPath(t), "add", name) // #nosec G204 — realGitPath is LookPath-resolved; name is a test literal
	cmd.Dir = dir
	cmd.Env = gitEnv(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v: %s", err, out)
	}
}

// commandIn builds a real-git command rooted at dir. Callers that reach it
// already required git via gitEnv/realGitPath.
func commandIn(dir string, args ...string) *exec.Cmd {
	p, err := exec.LookPath("git")
	if err != nil {
		panic("git not on PATH: " + err.Error())
	}
	cmd := exec.Command(p, args...) // #nosec G204 — p is LookPath-resolved git; args are fixed test literals
	cmd.Dir = dir
	return cmd
}

func writeFile(path, content string, mode os.FileMode) error {
	return os.WriteFile(path, []byte(content), mode)
}

func summary(s git.Status) string {
	return fmt.Sprintf("branch=%s head=%s staged=%d unstaged=%d conflicted=%d total=%d completeness=%s",
		s.Branch, s.Head, len(s.Staged), len(s.Unstaged), len(s.Conflicted), s.Total, s.Completeness)
}
