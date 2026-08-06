// Package spawn is everything about asking git a question that is shared by
// every implementation that actually runs git: argv construction and the
// porcelain v2 status parser.
//
// It is linked ONLY by code that runs git — local here, and the copy of
// local compiled into the relay helper build (AD-2). The relay CLIENT never
// imports it: a client that built argv or parsed porcelain would either put
// process vocabulary on the wire or compute an answer nobody uses (spec
// D16). The program name is not part of these argv tails for the same
// reason — the path to the binary is a local fact; the arguments are not.
package spawn

import (
	"fmt"

	"github.com/shady2k/nocx/internal/git"
)

// StatusArgs is the one invocation that answers the header and both lists
// (D7): git status --porcelain=v2 -z --branch --untracked-files=all. The
// branch, upstream and ahead/behind ride in the # branch.* records, and the
// ABSENCE of # branch.upstream / # branch.ab is what "no upstream" looks
// like — never a zero.
//
// --no-optional-locks is what makes this safe to POLL. Measured on git 2.55:
// a plain `git status` opportunistically refreshes the index and rewrites
// .git/index — the file's mtime moves on every run — while the same command
// with this flag leaves it untouched. The panel asks this question every few
// seconds, in a repository where an agent is running git in the terminal
// beside it, so a reader that mutates the index twelve times a minute is
// interference, not observation. This is the flag git added for exactly this
// caller.
func StatusArgs() []string {
	return []string{
		"--no-optional-locks",
		"status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all",
	}
}

// RevParseArgs asks git for the two values that are the binding's identity:
// the worktree root and the absolute git directory. git prints exactly two
// lines (verified on git 2.55); the caller validates that rather than
// trusting it.
func RevParseArgs() []string {
	return []string{"rev-parse", "--show-toplevel", "--absolute-git-dir"}
}

// AddArgs stages the pathspecs on stdin, NUL-separated (D8): paths never
// ride in argv for a mutation, because argv has an OS length cap and a path
// beginning with '-' would be read as an option.
func AddArgs() []string {
	return []string{"add", "--pathspec-from-file=-", "--pathspec-file-nul"}
}

// AddAllArgs is git add -A (D19). It is refused by the caller while any
// entry is conflicted: measured, git add -A marks the conflict resolved
// using a worktree file that still contains conflict markers.
func AddAllArgs() []string {
	return []string{"add", "-A"}
}

// ResetArgs unstages the pathspecs on stdin. Bare git reset is what makes
// unstage-all work on an unborn branch, where git restore --staged fails on
// an unresolvable HEAD — measured, no special unborn path is needed.
func ResetArgs() []string {
	return []string{"reset", "--pathspec-from-file=-", "--pathspec-file-nul"}
}

// ResetAllArgs is bare git reset — no HEAD, no pathspec (D19). It too is
// refused by the caller while any entry is conflicted: bare git reset during
// a conflicted merge deletes .git/MERGE_HEAD, silently aborting the merge.
func ResetAllArgs() []string {
	return []string{"reset"}
}

// CommitArgs is git commit with the message on stdin (-F -), never argv — a
// message with newlines and quotes is the normal case (D8). There is no
// --no-verify in this design and no setting that adds one: hooks always run.
func CommitArgs(amend bool) []string {
	if amend {
		return []string{"commit", "-F", "-", "--amend"}
	}
	return []string{"commit", "-F", "-"}
}

// HeadArgs reads the short hash of HEAD after a commit (the post-commit head
// read). "short" is git's own abbreviation.
func HeadArgs() []string {
	return []string{"rev-parse", "--short", "HEAD"}
}

// HeadMessageArgs reads the full HEAD message (subject and body) for the
// Amend prefill.
func HeadMessageArgs() []string {
	return []string{"log", "-1", "--format=%B"}
}

// DiffArgs builds the invocation for one side of one file (spec §5.1
// "diff.go"). The path rides in argv, protected by --, because diff is
// read-only; only mutations keep paths out of argv.
//
// --no-ext-diff on every form, because the panel renders the output AS a
// unified diff and a user's diff.external driver replaces it wholesale.
// Measured: with diff.external set to a script that echoes one line, plain
// `git diff` returns that line and nothing else; --no-ext-diff returns the
// real unified diff. Developers who use difftastic or delta as a diff driver
// have exactly this configured, and D6 runs git under the user's resolved
// environment, so this is the ordinary case rather than the exotic one.
func DiffArgs(side git.Side, path string) ([]string, error) {
	switch side {
	case git.SideStaged:
		return []string{"diff", "--no-ext-diff", "--cached", "--no-color", "--", path}, nil
	case git.SideUnstaged:
		return []string{"diff", "--no-ext-diff", "--no-color", "--", path}, nil
	case git.SideUntracked:
		// An untracked file has nothing to diff against; --no-index against
		// /dev/null is git's own answer, a real all-additions diff. It exits
		// 1 when there are differences, which is why the caller treats a
		// non-zero exit as data.
		return []string{
			"diff", "--no-ext-diff", "--no-index", "--no-color", "--", "/dev/null", path,
		}, nil
	default:
		return nil, fmt.Errorf("git: unknown diff side %q", side)
	}
}

// LiteralPathspec prefixes each path with :(literal) so that a path git
// reports verbatim — one that happens to contain glob metacharacters like
// `*` or `[` — is staged as itself and not as a pattern. The panel stages
// the row the user clicked, never a glob.
func LiteralPathspec(path string) string {
	return ":(literal)" + path
}
