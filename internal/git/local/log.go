package local

import (
	"context"
	"fmt"
	"time"

	"github.com/shady2k/nocx/internal/git"
	"github.com/shady2k/nocx/internal/git/spawn"
)

// Log answers "what has happened on this branch" (brief, git.log): the
// first max commits of HEAD, newest first, from one git log -z invocation.
// It is bounded by contract (D9): the invocation asks for max+1 records and
// the parser keeps counting past the retention point, so the answer is
// complete, capped (more than max exist — the extra record is the proof) or
// cut (a work ceiling stopped the stream mid-record; Total is a lower
// bound). A non-zero exit is the one failure that is data: on an unborn
// branch git log refuses to run, and the honest log of a branch with no
// commits is empty. The unborn fact has one owner — Status (D7) — so the
// check reuses it on the failure path instead of classifying git's prose
// (D11); when the status read itself fails, the log error is the honest
// answer.
func (r *Repo) Log(ctx context.Context, max int) (git.Log, error) {
	if max <= 0 {
		return git.Log{}, fmt.Errorf("git: log requires a positive bound, got %d", max)
	}
	p := spawn.NewLogParser(max)
	res := run(ctx, spec{
		argv:     append([]string{r.gitPath}, spawn.LogArgs(max)...),
		dir:      r.toplevel,
		env:      r.envSettled(),
		sink:     &logSink{p: p, maxBytes: r.ceilings.logBytes},
		deadline: time.Now().Add(r.ceilings.logWall),
	})
	if res.cancelled {
		return git.Log{}, ctx.Err()
	}
	if res.err != nil {
		return git.Log{}, res.err
	}
	parsed, err := p.Finish()
	if err != nil {
		return git.Log{}, fmt.Errorf("git: parse log: %w", err)
	}
	lg := git.Log{Entries: parsed.Entries, Total: parsed.Total}
	if res.cut || parsed.CutMidRecord {
		lg.Completeness = git.CompletenessCut
		return lg, nil
	}
	if res.exitCode != 0 {
		if st, stErr := r.Status(ctx); stErr == nil && st.Unborn {
			lg.Completeness = git.CompletenessComplete
			return lg, nil
		}
		return git.Log{}, fmt.Errorf("git log: exit %d: %s", res.exitCode, res.stderr)
	}
	lg.Completeness = git.CompletenessComplete
	if parsed.Total > max {
		lg.Completeness = git.CompletenessCapped
	}
	return lg, nil
}

// logSink feeds the log stream into the parser and applies the byte half of
// the work ceiling. The chunk that crosses the bound is fed UP TO the bound
// before the traversal is stopped deliberately: a cut is a prefix, and
// discarding an oversized chunk would throw away records the bound can
// afford — a cut of zero observed records is technically honest and
// practically useless.
type logSink struct {
	p        *spawn.LogParser
	maxBytes int64
	bytes    int64
}

func (s *logSink) Write(b []byte) (int, error) {
	room := s.maxBytes - s.bytes
	if room <= 0 {
		return 0, errEnough
	}
	if int64(len(b)) > room {
		b = b[:int(room)]
		if err := s.p.Write(b); err != nil {
			return 0, err
		}
		s.bytes += int64(len(b))
		return 0, errEnough
	}
	s.bytes += int64(len(b))
	if err := s.p.Write(b); err != nil {
		return 0, err
	}
	return len(b), nil
}
