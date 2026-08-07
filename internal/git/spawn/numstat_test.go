package spawn

import (
	"strings"
	"testing"
)

// The streams below are verbatim git 2.55 output (git diff --numstat -z)
// captured from repositories built for each case, frozen like the porcelain
// captures: each one is a real repository's real bytes, and the parser is
// regression-tested against them rather than against output the test built.

// A normal record: added, TAB, deleted, TAB, path, NUL.
const numstatModified = "3\t1\tf.txt\x00"

// A binary file: '-' in both columns — "no line count exists", not zero —
// so the path must NOT appear in the result at all (a fabricated 0/0 record
// would render +0 −0 for a file whose lines were never counted).
const numstatBinary = "-\t-\tbin.dat\x00"

// A rename record carries THREE NUL-separated fields: the counts header
// with an EMPTY path, then the FROM path, then the TO path. The counts
// belong to the TO path — the current path, the one the status entry names.
const numstatRename = "0\t0\t\x00old.txt\x00new.txt\x00"

// A rename detected WITH content changes: the counts ride the same triple.
const numstatRenameChanged = "5\t1\t\x00old.txt\x00new.txt\x00"

// -z is not decoration: a path may contain a newline.
const numstatNewline = "2\t0\twe\nird.txt\x00"

func parseNumstat(t *testing.T, stream string, writes ...int) NumstatResult {
	t.Helper()
	p := NewNumstatParser()
	if len(writes) == 0 {
		if err := p.Write([]byte(stream)); err != nil {
			t.Fatalf("Write: %v", err)
		}
	} else {
		// Split the stream at the given byte offsets to prove fields that
		// cross write boundaries still parse (a bounded pipe delivers
		// mid-record routinely).
		at := 0
		for _, w := range writes {
			if w > len(stream) {
				t.Fatalf("write offset %d beyond stream", w)
			}
			if err := p.Write([]byte(stream[at:w])); err != nil {
				t.Fatalf("Write(%d): %v", w, err)
			}
			at = w
		}
		if at < len(stream) {
			if err := p.Write([]byte(stream[at:])); err != nil {
				t.Fatalf("Write(tail): %v", err)
			}
		}
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	return res
}

func wantCounts(t *testing.T, res NumstatResult, path string, added, deleted int) {
	t.Helper()
	c, ok := res.Counts[path]
	if !ok {
		t.Fatalf("no record for %q in %+v", path, res.Counts)
	}
	if c.Added != added || c.Deleted != deleted {
		t.Fatalf("%q = +%d −%d, want +%d −%d", path, c.Added, c.Deleted, added, deleted)
	}
}

func TestNumstatParsesModified(t *testing.T) {
	res := parseNumstat(t, numstatModified)
	wantCounts(t, res, "f.txt", 3, 1)
}

func TestNumstatBinaryIsAbsentNotZero(t *testing.T) {
	res := parseNumstat(t, numstatBinary)
	if _, ok := res.Counts["bin.dat"]; ok {
		t.Fatalf("a binary file must have no record: %+v", res.Counts)
	}
	if len(res.Counts) != 0 {
		t.Fatalf("Counts = %+v, want empty", res.Counts)
	}
}

func TestNumstatRenameCountsKeyTheToPath(t *testing.T) {
	res := parseNumstat(t, numstatRename)
	wantCounts(t, res, "new.txt", 0, 0)
	if _, ok := res.Counts["old.txt"]; ok {
		t.Fatalf("the FROM path must not carry the counts: %+v", res.Counts)
	}
}

func TestNumstatRenameWithContentChange(t *testing.T) {
	res := parseNumstat(t, numstatRenameChanged)
	wantCounts(t, res, "new.txt", 5, 1)
}

func TestNumstatPathWithNewline(t *testing.T) {
	res := parseNumstat(t, numstatNewline)
	wantCounts(t, res, "we\nird.txt", 2, 0)
}

func TestNumstatEmptyStreamIsAValidAnswer(t *testing.T) {
	res := parseNumstat(t, "")
	if len(res.Counts) != 0 {
		t.Fatalf("Counts = %+v, want empty", res.Counts)
	}
}

func TestNumstatFieldsSplitAcrossWrites(t *testing.T) {
	stream := numstatModified + numstatRename + numstatBinary + numstatNewline
	// Write boundaries that split mid-field, mid-record and at a NUL.
	res := parseNumstat(t, stream, 3, 9, 17, 24, 40, 55)
	wantCounts(t, res, "f.txt", 3, 1)
	wantCounts(t, res, "new.txt", 0, 0)
	if _, ok := res.Counts["bin.dat"]; ok {
		t.Fatalf("binary present: %+v", res.Counts)
	}
	wantCounts(t, res, "we\nird.txt", 2, 0)
}

func TestNumstatDropsInterruptedTrailingField(t *testing.T) {
	// A trailing fragment with no NUL is an interrupted record, not a
	// record: git's -z output terminates every one, so the fragment is
	// dropped exactly as the porcelain parser drops its own.
	res := parseNumstat(t, numstatModified+"12\t7\tpar")
	wantCounts(t, res, "f.txt", 3, 1)
	if _, ok := res.Counts["par"]; ok {
		t.Fatalf("an unterminated fragment parsed as a record: %+v", res.Counts)
	}
}

func TestNumstatPathContainingTabs(t *testing.T) {
	// -z means git does not munge pathnames, so a path may contain a TAB.
	// The parser splits the record on the first TWO tabs only: the counts
	// are the first two columns and the path is everything after the
	// second, tabs included.
	stream := "4\t2\twe\tird.txt\x00"
	res := parseNumstat(t, stream)
	wantCounts(t, res, "we\tird.txt", 4, 2)
}

func TestNumstatMalformedRecordErrors(t *testing.T) {
	for _, stream := range []string{
		"no tabs here\x00",
		"x\ty\tf.txt\x00", // a non-numeric count
		"1\tf.txt\x00",    // a missing column
	} {
		p := NewNumstatParser()
		if err := p.Write([]byte(stream)); err == nil {
			t.Fatalf("stream %q parsed without error", stream)
		}
	}
}

func TestNumstatArgsForms(t *testing.T) {
	worktree := NumstatArgs(false)
	if got := strings.Join(worktree, " "); got != "diff --numstat -z --no-ext-diff" {
		t.Fatalf("worktree argv = %q", got)
	}
	cached := NumstatArgs(true)
	if got := strings.Join(cached, " "); got != "diff --cached --numstat -z --no-ext-diff" {
		t.Fatalf("cached argv = %q", got)
	}
	// --no-ext-diff rides every diff form (the user's diff.external driver
	// must never reach the panel's reads); --no-optional-locks deliberately
	// does NOT — git diff rejects it, and the local implementation carries
	// that decision in GIT_OPTIONAL_LOCKS=0 instead.
	for _, args := range [][]string{worktree, cached} {
		for _, arg := range args {
			if arg == "--no-optional-locks" {
				t.Fatalf("git diff rejects --no-optional-locks: %v", args)
			}
		}
	}
}
