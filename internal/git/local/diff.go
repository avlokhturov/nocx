package local

import (
	"context"
	"fmt"
	"strings"

	"github.com/shady2k/nocx/internal/git"
	"github.com/shady2k/nocx/internal/git/spawn"
)

// Diff renders one side of one file's unified diff (spec §5.1 "diff.go").
// The three forms map from the side the row was in:
//
//	Staged     → git diff --cached --no-color -- <path>
//	Unstaged   → git diff --no-color -- <path>
//	Untracked  → git diff --no-index --no-color -- /dev/null <path>
//
// The untracked form is the interesting one: an untracked file has nothing
// to diff against, and --no-index against /dev/null is git's own answer — a
// real all-additions diff that exits 1 when there are differences, which is
// why a non-zero exit is data here, not an error.
//
// The diff terminates deliberately at maxBytes: the retained text is a
// prefix, the state is tooLarge, and nothing else crosses Repo — the cut
// stays in local's private execution record.
func (r *Repo) Diff(ctx context.Context, path string, side git.Side, maxBytes int64) (git.Diff, error) {
	if maxBytes <= 0 {
		return git.Diff{}, fmt.Errorf("git: diff requires a positive byte bound, got %d", maxBytes)
	}
	args, err := spawn.DiffArgs(side, path)
	if err != nil {
		return git.Diff{}, err
	}
	sink := &byteSink{max: maxBytes}
	res := run(ctx, spec{
		argv: append([]string{r.gitPath}, args...),
		dir:  r.toplevel,
		env:  r.envSettled(),
		sink: sink,
	})
	if res.cancelled {
		return git.Diff{}, ctx.Err()
	}
	if res.err != nil {
		return git.Diff{}, res.err
	}
	text := string(sink.buf)
	if res.cut {
		// The byte bound was reached. The child was killed and reaped; the
		// broken pipe that followed was expected. The public state says
		// tooLarge and nothing about how the pipe was cut.
		return git.Diff{State: git.DiffTooLarge, Text: text, Truncated: true}, nil
	}

	if side == git.SideUntracked {
		switch {
		case res.exitCode == 0:
			if text == "" {
				return git.Diff{State: git.DiffEmpty}, nil
			}
			return git.Diff{State: git.DiffOK, Text: text}, nil
		case res.exitCode == 1:
			// 1 means "there are differences" — and, measured, also "the
			// path cannot be accessed" (error: Could not access '…'), which
			// produces no output at all.
			if isBinary(text) {
				return git.Diff{State: git.DiffBinary}, nil
			}
			if text != "" {
				return git.Diff{State: git.DiffOK, Text: text}, nil
			}
			return git.Diff{State: git.DiffGone}, nil
		default:
			if isGone(res.stderr) {
				return git.Diff{State: git.DiffGone}, nil
			}
			return git.Diff{}, fmt.Errorf("git diff: exit %d: %s", res.exitCode, res.stderr)
		}
	}

	// Staged and unstaged: git exits 0 with or without differences, so an
	// exit code other than 0 is an error — except the path-missing cases,
	// which read as gone. A path the index/worktree no longer knows about
	// exits 0 with no output (measured), which is empty: "no differences".
	switch {
	case res.exitCode == 0:
		if isBinary(text) {
			return git.Diff{State: git.DiffBinary}, nil
		}
		if text == "" {
			return git.Diff{State: git.DiffEmpty}, nil
		}
		return git.Diff{State: git.DiffOK, Text: text}, nil
	default:
		if isGone(res.stderr) {
			return git.Diff{State: git.DiffGone}, nil
		}
		return git.Diff{}, fmt.Errorf("git diff: exit %d: %s", res.exitCode, res.stderr)
	}
}

// isBinary reports git's own binary verdict. It is a full line of its own,
// never a hunk line, in every form including --no-index (measured):
// "Binary files a/X and b/X differ".
func isBinary(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "Binary file") {
			return true
		}
	}
	return false
}

// isGone reports the path-missing error markers git prints when the diffed
// path no longer exists on the asked side.
func isGone(stderr string) bool {
	return strings.Contains(stderr, "No such file or directory") ||
		strings.Contains(stderr, "Could not access") ||
		strings.Contains(stderr, "not in the working tree") ||
		strings.Contains(stderr, "ambiguous argument") ||
		strings.Contains(stderr, "unknown revision")
}
