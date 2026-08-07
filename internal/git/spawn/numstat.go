package spawn

import (
	"fmt"
	"strconv"
	"strings"
)

// NumstatResult is the parsed content of one git diff --numstat -z stream:
// the line counts of every changed tracked file. Absence is meaningful — a
// path with no entry here has no line count, either because git printed '-'
// (a binary file, where "no line count exists" is not zero) or because the
// file is not part of this diff at all (an untracked file; the numstat
// stream never lists them).
type NumstatResult struct {
	Counts map[string]NumstatCount
}

// NumstatCount is one file's added/deleted line counts. It exists only for
// files git could count; a binary file has no NumstatCount at all.
type NumstatCount struct {
	Added   int
	Deleted int
}

// NumstatParser consumes a git diff [--cached] --numstat -z stream
// incrementally, mirroring the porcelain parser's shape so the same bounded
// read machinery serves both: the sink can stop the traversal at the work
// ceiling and the parser never sees the cut as an error.
//
// The stream is NUL-terminated records, and -z is not decoration — a path
// may contain a newline, which is why the record ends at a NUL and never at
// a line end. Within one record the fields are TAB-separated, and the
// parser splits on the first TWO tabs only: the added and deleted columns
// are the first two tokens, and the path is everything after the second tab
// (a path may itself contain tabs, and -z means git does not munge it).
//
// The case that is not the common case is a rename or copy record, which
// emits THREE NUL-separated fields rather than one (measured on git 2.55):
// the counts header with an EMPTY path, then the FROM path, then the TO
// path. The counts belong to the TO path — the current path, the one the
// porcelain status entry names. A rename detected with content changes
// splits into ordinary delete/add records instead; both shapes parse here.
type NumstatParser struct {
	buf     []byte // partial field
	state   numstatState
	pending NumstatCount // counts of a rename record being consumed
	skip    bool         // the pending record's counts are not recordable (binary rename)
	Result  NumstatResult
	err     error
}

type numstatState int

const (
	numstatHeader numstatState = iota // the next field is a counts header
	numstatFrom                       // a rename record: the FROM path field
	numstatTo                         // a rename record: the TO path field
)

// NewNumstatParser returns a parser ready for a numstat stream.
func NewNumstatParser() *NumstatParser {
	return &NumstatParser{
		Result: NumstatResult{Counts: map[string]NumstatCount{}},
		state:  numstatHeader,
	}
}

// Write feeds more of the stream into the parser. It returns an error only
// for a malformed record — a stream git itself wrote should never produce
// one, so it is a real failure rather than something to paper over. A field
// split across writes is buffered, exactly as the porcelain parser buffers:
// a bounded pipe routinely delivers mid-record.
func (p *NumstatParser) Write(b []byte) error {
	p.buf = append(p.buf, b...)
	for {
		i := indexByte(p.buf, 0)
		if i < 0 {
			return p.err
		}
		field := string(p.buf[:i])
		p.buf = p.buf[i+1:]
		if perr := p.field(field); perr != nil {
			p.err = perr
			return perr
		}
	}
}

// Finish reports the parse result. A trailing partial field (no terminating
// NUL) is dropped: git's -z output terminates every record, so a missing
// terminator means the stream was interrupted mid-record, and a fragment is
// not a record.
func (p *NumstatParser) Finish() (NumstatResult, error) {
	if p.err != nil {
		return NumstatResult{}, p.err
	}
	return p.Result, nil
}

// field handles one complete NUL-delimited field.
func (p *NumstatParser) field(f string) error {
	switch p.state {
	case numstatFrom:
		// The FROM side of a rename — consumed, not retained; the counts
		// key the TO side, the path the status entry names.
		p.state = numstatTo
		return nil
	case numstatTo:
		if !p.skip {
			p.Result.Counts[f] = p.pending
		}
		p.state = numstatHeader
		return nil
	case numstatHeader:
		return p.header(f)
	}
	return nil
}

// header handles the counts-and-path field that opens every record.
func (p *NumstatParser) header(f string) error {
	parts := strings.SplitN(f, "\t", 3)
	if len(parts) != 3 {
		return fmt.Errorf("git: malformed numstat record %q", f)
	}
	added, hasAdded, err := numstatCount(parts[0])
	if err != nil {
		return err
	}
	deleted, hasDeleted, err := numstatCount(parts[1])
	if err != nil {
		return err
	}
	count := NumstatCount{Added: added, Deleted: deleted}
	if parts[2] == "" {
		// A rename or copy record: two more fields follow, FROM then TO.
		// The TO path carries the counts.
		p.pending = count
		p.skip = !hasAdded || !hasDeleted
		p.state = numstatFrom
		return nil
	}
	if hasAdded && hasDeleted {
		p.Result.Counts[parts[2]] = count
	}
	return nil
}

// numstatCount reads one numstat column. '-' is a binary file — "no line
// count exists", not zero — and is reported as countless rather than as an
// error, because git writes it routinely. Anything else that is not a
// number is a stream git never wrote and is an error.
func numstatCount(s string) (n int, has bool, err error) {
	if s == "-" {
		return 0, false, nil
	}
	n, err = strconv.Atoi(s)
	if err != nil {
		return 0, false, fmt.Errorf("git: malformed numstat count %q", s)
	}
	return n, true, nil
}

// NumstatArgs builds the line-count invocation for one side of the status
// (brief nocx-i4ki): git diff [--cached] --numstat -z --no-ext-diff.
//
// --no-ext-diff rides every diff form for the same reason it rides
// DiffArgs: a user's diff.external driver replaces the output wholesale
// (measured), and the panel renders what git prints. --numstat is a
// diff-family option, so --no-optional-locks — a STATUS-only flag that git
// diff rejects — is deliberately not here; the same decision is carried by
// GIT_OPTIONAL_LOCKS=0 in the invocation environment instead (local applies
// it). Measured on git 2.55: plain `git diff` does not rewrite .git/index
// the way plain `git status` does, and the env var pins that behaviour
// even if a future git changes its mind.
func NumstatArgs(cached bool) []string {
	args := []string{"diff"}
	if cached {
		args = append(args, "--cached")
	}
	return append(args, "--numstat", "-z", "--no-ext-diff")
}
