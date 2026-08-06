package local

import (
	"context"
	"fmt"
	"strings"

	"github.com/shady2k/nocx/internal/git"
	"github.com/shady2k/nocx/internal/git/spawn"
)

// Commit runs git commit with the message on stdin (-F -) — never argv,
// because a message with newlines and quotes is the normal case (D8) — and
// interprets the exit without classifying the cause (D11): zero → ok with
// the new head; non-zero → failed carrying git's own stdout and stderr as
// far as the bound allows, with the truncation mark set when it was reached.
// We do not guess whether a hook, a signing key or an index lock produced
// it; git's output is the only accurate account.
//
// There is no identity preflight: git's real answer to "can it identify the
// author" involves environment variables, conditional includes and
// user.useConfigOnly, and a second implementation of that question could
// refuse a commit git would accept. Missing identity is an ordinary failed
// whose output happens to be git's four-paragraph explanation.
//
// There is no --no-verify in this design and no setting that adds one: hooks
// always run.
func (r *Repo) Commit(ctx context.Context, msg string, amend bool) (git.CommitOutcome, error) {
	// Refuse early, before running a hook that would then fail confusingly:
	// nothing staged, or an amend with nothing to amend against.
	st, err := r.Status(ctx)
	if err != nil {
		return git.CommitOutcome{}, err
	}
	if len(st.Staged) == 0 {
		return git.CommitOutcome{}, &git.ErrNothingToCommit{}
	}
	if amend && st.Unborn {
		return git.CommitOutcome{}, &git.ErrAmendUnborn{}
	}

	sink := &byteSink{max: git.MaxCommitOutputBytes}
	res := run(ctx, spec{
		argv:      append([]string{r.gitPath}, spawn.CommitArgs(amend)...),
		dir:       r.toplevel,
		env:       r.env,
		stdin:     strings.NewReader(msg),
		sink:      sink,
		stderrMax: git.MaxCommitOutputBytes,
	})
	if res.cancelled {
		return git.CommitOutcome{}, ctx.Err()
	}
	if res.err != nil {
		return git.CommitOutcome{}, res.err
	}
	output := strings.TrimSpace(string(sink.buf))
	if res.stderr != "" {
		if output != "" {
			output += "\n"
		}
		output += strings.TrimSpace(res.stderr)
	}
	if res.exitCode != 0 {
		return git.CommitOutcome{
			State:           git.CommitFailed,
			Output:          output,
			OutputTruncated: res.stderrCut || res.cut,
		}, nil
	}

	// The commit happened. Read the new head; if that read fails, the
	// outcome still says ok — the panel must say "committed", not "failed",
	// with the head unknown. Then the fresh post-commit status (D12); if it
	// fails, StatusStale names it rather than letting a zero status render
	// as a fresh one.
	head := ""
	headSink := &byteSink{max: 8 << 10}
	hres := run(ctx, spec{
		argv: append([]string{r.gitPath}, spawn.HeadArgs()...),
		dir:  r.toplevel,
		env:  r.env,
		sink: headSink,
	})
	if hres.err == nil && !hres.cancelled && hres.exitCode == 0 {
		head = strings.TrimSpace(string(headSink.buf))
	}

	st2, stErr := r.Status(ctx)
	if stErr != nil {
		return git.CommitOutcome{
			State: git.CommitOK,
			Head:  head,
			Status: git.Status{
				Staged:     []git.Entry{},
				Unstaged:   []git.Entry{},
				Conflicted: []git.Entry{},
			},
			StatusStale: true,
		}, nil
	}
	return git.CommitOutcome{State: git.CommitOK, Head: head, Status: st2}, nil
}

// HeadMessage is the Amend prefill: the full HEAD message (subject and body)
// fetched once when the box is ticked. A non-zero exit is data — the unborn
// branch has no message to prefill — so it maps to HeadMessageNone, not an
// error; an invocation that cannot be made is the error.
func (r *Repo) HeadMessage(ctx context.Context) (git.HeadMessage, error) {
	sink := &byteSink{max: git.MaxCommitOutputBytes}
	res := run(ctx, spec{
		argv: append([]string{r.gitPath}, spawn.HeadMessageArgs()...),
		dir:  r.toplevel,
		env:  r.env,
		sink: sink,
	})
	if res.cancelled {
		return git.HeadMessage{}, ctx.Err()
	}
	if res.err != nil {
		return git.HeadMessage{}, res.err
	}
	if res.cut {
		// A message longer than the bound is not a prefill; a silently
		// truncated one would be.
		return git.HeadMessage{}, fmt.Errorf("git: HEAD message exceeds the %d-byte bound", git.MaxCommitOutputBytes)
	}
	if res.exitCode != 0 {
		return git.HeadMessage{State: git.HeadMessageNone}, nil
	}
	return git.HeadMessage{State: git.HeadMessageOK, Message: string(sink.buf)}, nil
}
