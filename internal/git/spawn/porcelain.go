package spawn

import (
	"fmt"
	"strings"

	"github.com/shady2k/nocx/internal/git"
)

// Result is the parsed content of one porcelain v2 -z status stream, minus
// the completeness discriminator: the parser observes records, so whether the
// traversal was stopped early is a fact about the execution, not the stream,
// and local decides complete/capped/cut.
type Result struct {
	Branch     string // "" when detached
	Detached   bool
	Unborn     bool
	Head       string // short hash (first 7 hex digits of the full oid); "" when unborn
	Upstream   string // "" when the branch has none
	Ahead      int
	Behind     int
	Staged     []git.Entry
	Unstaged   []git.Entry
	Conflicted []git.Entry
	Total      int // records counted; exact unless the stream was cut
}

// Parser consumes a git status --porcelain=v2 -z --branch
// --untracked-files=all stream incrementally. It retains the first max
// records — records, not entries: one record can land a file in both lists —
// and keeps counting the rest, which is what lets Total be exact while the
// lists stay bounded (D9).
//
// The stream is a sequence of NUL-terminated records, and a rename record
// carries TWO paths in one record separated by a NUL of its own: getting that
// wrong shifts every later record by one field. The parser therefore works on
// NUL-delimited fields, never lines — a path may contain a newline, which is
// the whole reason -z exists.
//
// Every record type carries its path inside its header field except '2'
// (rename/copy) records, whose header field carries path1 and is followed by
// one more field, path2. Verified against git 2.55 output: the header's
// embedded path is the current path — the one the user sees — and the extra
// field is the other side of the rename, consumed and dropped. Conflict ('u')
// records carry one path (measured: a rename conflict renders as a
// single-path 'u' record plus a separate '1 A.' record for the rename).
type Parser struct {
	max    int
	buf    []byte // partial field
	state  parseState
	Result Result
	err    error
}

type parseState int

const (
	stateHeader parseState = iota // the next field is a record header
	statePath2                    // a '2' record: one more path field follows
)

// NewParser returns a parser that retains the first max records. The lists
// start non-nil: an empty status marshals as [], never null.
func NewParser(max int) *Parser {
	return &Parser{
		max: max,
		Result: Result{
			Staged:     []git.Entry{},
			Unstaged:   []git.Entry{},
			Conflicted: []git.Entry{},
		},
		state: stateHeader,
	}
}

// Write feeds more of the stream into the parser. It returns an error only
// for a malformed record — a stream git itself wrote should never produce
// one, so it is a real failure rather than something to paper over.
func (p *Parser) Write(b []byte) error {
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
func (p *Parser) Finish() (Result, error) {
	if p.err != nil {
		return Result{}, p.err
	}
	return p.Result, nil
}

// field handles one complete NUL-delimited field.
func (p *Parser) field(f string) error {
	switch p.state {
	case statePath2:
		// path2 of a '2' record — consumed, not retained; the entry's path
		// is the one embedded in the header field.
		p.state = stateHeader
		return nil
	case stateHeader:
		return p.header(f)
	}
	return nil
}

func (p *Parser) header(f string) error {
	switch {
	case strings.HasPrefix(f, "#"):
		return p.branchHeader(f)
	case strings.HasPrefix(f, "1 "):
		return p.tracked(f, 8)
	case strings.HasPrefix(f, "2 "):
		p.state = statePath2
		return p.tracked(f, 9)
	case strings.HasPrefix(f, "u "):
		return p.conflict(f)
	case strings.HasPrefix(f, "? "):
		return p.untracked(f)
	case strings.HasPrefix(f, "! "):
		// Ignored record — git emits these only with --ignored, which this
		// design never passes. Counted nowhere: it is not a change.
		return nil
	default:
		return fmt.Errorf("git: malformed status record %q", f)
	}
}

// branchHeader parses the # branch.* records. The absence of # branch.upstream
// and # branch.ab is what "no upstream" looks like — never a zero.
func (p *Parser) branchHeader(f string) error {
	switch {
	case strings.HasPrefix(f, "# branch.oid "):
		oid := strings.TrimPrefix(f, "# branch.oid ")
		if oid == "(initial)" {
			p.Result.Unborn = true
			p.Result.Head = ""
		} else {
			p.Result.Head = shortHead(oid)
		}
	case strings.HasPrefix(f, "# branch.head "):
		name := strings.TrimPrefix(f, "# branch.head ")
		if name == "(detached)" {
			p.Result.Detached = true
			p.Result.Branch = ""
		} else {
			p.Result.Branch = name
		}
	case strings.HasPrefix(f, "# branch.upstream "):
		p.Result.Upstream = strings.TrimPrefix(f, "# branch.upstream ")
	case strings.HasPrefix(f, "# branch.ab "):
		rest := strings.TrimPrefix(f, "# branch.ab ")
		var ahead, behind int
		if _, err := fmt.Sscanf(rest, "+%d -%d", &ahead, &behind); err == nil {
			p.Result.Ahead = ahead
			p.Result.Behind = behind
		}
		// A form git does not write is ignored, not fatal: the record is
		// still a header, and misreading ahead/behind is safer than failing
		// the whole parse on a cosmetic field.
	}
	return nil
}

// tracked handles a '1' or '2' record. The field is a fixed number of
// space-separated header tokens followed by the path — which may itself
// contain spaces, so it is the rejoined remainder, never a single token.
// A '1' record has 8 header tokens (type, XY, sub, mH, mI, mW, hH, hI) and
// its path starts at token 8; a '2' record adds the <X><score> token, so its
// path1 starts at token 9.
func (p *Parser) tracked(f string, pathAt int) error {
	fields := strings.Split(f, " ")
	if len(fields) < pathAt+1 {
		return fmt.Errorf("git: malformed status record %q", f)
	}
	xy := fields[1]
	if len(xy) != 2 {
		return fmt.Errorf("git: malformed status columns %q", xy)
	}
	path := strings.Join(fields[pathAt:], " ")
	p.retainTracked(git.Entry{Path: path, X: xy[0], Y: xy[1]})
	return nil
}

// retainTracked files a tracked record into the lists. A file with both
// columns non-'.' lands in both lists — the panel's row key is {side, path}
// because of it (spec §5.1 "porcelain.go").
func (p *Parser) retainTracked(e git.Entry) {
	if p.Result.Total < p.max {
		if e.X != '.' {
			p.Result.Staged = append(p.Result.Staged, e)
		}
		if e.Y != '.' {
			p.Result.Unstaged = append(p.Result.Unstaged, e)
		}
	}
	p.Result.Total++
}

// conflict handles a 'u' record — ten header tokens then the path. The entry
// is conflicted and never stageable from the panel; the two status columns
// are the conflict code (UU, UD, …).
func (p *Parser) conflict(f string) error {
	fields := strings.Split(f, " ")
	if len(fields) < 11 {
		return fmt.Errorf("git: malformed conflict record %q", f)
	}
	xy := fields[1]
	if len(xy) != 2 {
		return fmt.Errorf("git: malformed conflict code %q", xy)
	}
	path := strings.Join(fields[10:], " ")
	if p.Result.Total < p.max {
		p.Result.Conflicted = append(p.Result.Conflicted, git.Entry{Path: path, X: xy[0], Y: xy[1]})
	}
	p.Result.Total++
	return nil
}

// untracked handles a '?' record — one token then the path. Untracked files
// live in the unstaged list with ?/? columns; the panel maps them to the
// --no-index diff form.
func (p *Parser) untracked(f string) error {
	fields := strings.Split(f, " ")
	if len(fields) < 2 {
		return fmt.Errorf("git: malformed untracked record %q", f)
	}
	path := strings.Join(fields[1:], " ")
	if p.Result.Total < p.max {
		p.Result.Unstaged = append(p.Result.Unstaged, git.Entry{Path: path, X: '?', Y: '?'})
	}
	p.Result.Total++
	return nil
}

// shortHead shortens the full oid the header carries to git's conventional
// default abbreviation, matching what rev-parse --short prints for the
// common case.
func shortHead(oid string) string {
	if len(oid) > 7 {
		return oid[:7]
	}
	return oid
}

func indexByte(b []byte, c byte) int {
	for i, v := range b {
		if v == c {
			return i
		}
	}
	return -1
}
