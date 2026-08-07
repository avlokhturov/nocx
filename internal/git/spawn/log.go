package spawn

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"github.com/shady2k/nocx/internal/git"
)

// LogParser consumes a git log -z --format stream incrementally (LogArgs).
// Every record is six NUL-separated values — %H, %h, %s, %an, %aI, %D —
// where the NUL after %D is the record terminator the -z flag emits in
// place of a newline. A commit with no refs prints an empty %D, which is
// an empty SIXTH field: the fixed field count is what keeps records
// aligned, and a line-based parser could not — a subject may contain a
// newline or a tab, which is the whole reason -z exists. Verified against
// git 2.55 output.
//
// The parser retains the first max records and keeps counting the rest,
// which is what lets Total be exact while the list stays bounded (D9).
// A stream that ends mid-record — the work ceiling cut the child — is
// reported through CutMidRecord, never as a clean end: a silently
// truncated list is the exact lie the bounded read exists to refuse.
type LogParser struct {
	max     int
	buf     []byte   // partial field
	fields  []string // fields of the record being read
	entries []git.LogEntry
	total   int
	err     error
}

// LogResult is the parsed content of one git log -z stream, minus the
// completeness discriminator: whether the traversal was stopped early is a
// fact about the execution, not the stream, and local decides
// complete/capped/cut. CutMidRecord is the parser half of that fact — the
// stream ended before a record's terminator arrived — which a clean -z
// stream never does.
type LogResult struct {
	Entries      []git.LogEntry
	Total        int
	CutMidRecord bool
}

// NewLogParser returns a parser that retains the first max records. The
// entries start non-nil: an empty log marshals as [], never null.
func NewLogParser(max int) *LogParser {
	return &LogParser{
		max:     max,
		entries: []git.LogEntry{},
	}
}

// Write feeds more of the stream into the parser. It returns an error only
// for a malformed record — a stream git itself wrote should never produce
// one, so it is a real failure rather than something to paper over.
func (p *LogParser) Write(b []byte) error {
	p.buf = append(p.buf, b...)
	for {
		i := bytes.IndexByte(p.buf, 0)
		if i < 0 {
			return p.err
		}
		field := string(p.buf[:i])
		p.buf = p.buf[i+1:]
		if err := p.field(field); err != nil {
			p.err = err
			return err
		}
	}
}

// field handles one complete NUL-delimited field; six of them are one
// record. A record that carries a non-empty sixth field is a git whose
// record grammar we do not know — the next record's fields would shift by
// one — but that misalignment surfaces where it lands: an unparseable
// author date or a stream that never completes, both real failures rather
// than guesses.
func (p *LogParser) field(f string) error {
	p.fields = append(p.fields, f)
	if len(p.fields) < 6 {
		return nil
	}
	entry, err := parseLogEntry(p.fields[:6])
	if err != nil {
		return err
	}
	p.total++
	if len(p.entries) < p.max {
		p.entries = append(p.entries, entry)
	}
	p.fields = p.fields[:0]
	return nil
}

// parseLogEntry builds one commit from its six values.
func parseLogEntry(f []string) (git.LogEntry, error) {
	authoredAt, err := time.Parse(time.RFC3339, f[4])
	if err != nil {
		return git.LogEntry{}, fmt.Errorf("git: malformed log record: author date %q: %w", f[4], err)
	}
	return git.LogEntry{
		Hash:       f[0],
		ShortHash:  f[1],
		Subject:    f[2],
		AuthorName: f[3],
		AuthoredAt: authoredAt,
		Refs:       parseRefs(f[5]),
	}, nil
}

// parseRefs splits the %D decoration list into the names the panel shows,
// stripping git's decoration prefixes: "HEAD -> main" is the current
// branch, "tag: v1.0" is a tag, and a bare "HEAD" is a detached HEAD — the
// state the panel must be able to say out loud (brief: detached HEAD works
// and must say so through the refs it returns).
func parseRefs(d string) []string {
	if d == "" {
		return []string{}
	}
	parts := strings.Split(d, ", ")
	refs := make([]string, 0, len(parts))
	for _, part := range parts {
		ref := strings.TrimPrefix(part, "HEAD -> ")
		ref = strings.TrimPrefix(ref, "tag: ")
		refs = append(refs, ref)
	}
	return refs
}

// Finish reports the parse result. A non-empty trailing field, or fields of
// a record whose terminator never arrived, mean the stream was interrupted
// mid-record — the work ceiling cut the child — which is the cut signal,
// never a clean end.
func (p *LogParser) Finish() (LogResult, error) {
	if p.err != nil {
		return LogResult{}, p.err
	}
	res := LogResult{Entries: p.entries, Total: p.total}
	if len(p.buf) > 0 || len(p.fields) > 0 {
		res.CutMidRecord = true
	}
	return res, nil
}
