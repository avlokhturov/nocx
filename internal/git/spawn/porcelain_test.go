package spawn

import (
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/git"
)

// The captured streams below are verbatim git 2.55 output (status
// --porcelain=v2 -z --branch --untracked-files=all) from repositories built
// for each case. They are frozen on purpose: each one is a real repository's
// real output, and the parser is regression-tested against the bytes, not
// against output the test built.

const statusUnborn = "# branch.oid (initial)\x00# branch.head master\x00" +
	"1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 f.txt\x00"

const statusDetached = "# branch.oid 2334598ae18d1be09f81a763531144bb8620d57f\x00# branch.head (detached)\x00" +
	"1 .M N... 100644 100644 100644 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 f.txt\x00" +
	"? untracked.txt\x00"

// A rename record carries TWO paths in one record, separated by a NUL of its
// own: the header field ends with the current path, and the second field is
// the other side of the rename. A line-oriented parser shifts every later
// record by one field here.
const statusRename = "# branch.oid 2334598ae18d1be09f81a763531144bb8620d57f\x00# branch.head master\x00" +
	"2 R. N... 100644 100644 100644 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 R100 renamed.txt\x00f.txt\x00"

// -z is not decoration: a path may contain a newline, and the record stays
// one record.
const statusNewline = "# branch.oid (initial)\x00# branch.head master\x00" +
	"? we\nird.txt\x00"

// A file can be in both lists — XY with both columns non-'.'.
const statusBoth = "# branch.oid 5c78a74729a56bd52a6c9f715c06a4c3d930a6ed\x00# branch.head master\x00" +
	"1 MM N... 100644 100644 100644 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 626799f0f85326a8c1fc522db584e86cdfccd51f f.txt\x00"

const statusConflict = "# branch.oid 5596fa113ae218bc8f590965544b1f047e483a82\x00# branch.head master\x00" +
	"u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 1f7391f92b6a3792204e07e99f71f643cc35e7e1 0f62d67e76ce1255a098942495a846df0f8a2c11 f.txt\x00"

// An upstream with ahead/behind: # branch.upstream and # branch.ab carry
// them. Their ABSENCE is what "no upstream" looks like — never a zero.
const statusUpstream = "# branch.oid 59670ec677b5128530e0d58f1ea635c8ef9bd432\x00# branch.head master\x00" +
	"# branch.upstream origin/master\x00# branch.ab +1 -0\x00"

func parse(t *testing.T, stream string, max int) Result {
	t.Helper()
	p := NewParser(max)
	if err := p.Write([]byte(stream)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	return res
}

func TestParseUnborn(t *testing.T) {
	res := parse(t, statusUnborn, 5000)
	if !res.Unborn {
		t.Fatal("unborn branch not detected (branch.oid (initial))")
	}
	if res.Head != "" {
		t.Fatalf("Head = %q, want empty on unborn", res.Head)
	}
	if res.Branch != "master" {
		t.Fatalf("Branch = %q", res.Branch)
	}
	if res.Total != 1 {
		t.Fatalf("Total = %d, want 1", res.Total)
	}
	if len(res.Staged) != 1 || res.Staged[0].Path != "f.txt" || res.Staged[0].X != 'A' || res.Staged[0].Y != '.' {
		t.Fatalf("Staged = %+v", res.Staged)
	}
}

func TestParseDetached(t *testing.T) {
	res := parse(t, statusDetached, 5000)
	if !res.Detached {
		t.Fatal("detached HEAD not detected")
	}
	if res.Branch != "" {
		t.Fatalf("Branch = %q, want empty when detached", res.Branch)
	}
	if res.Head != "2334598" {
		t.Fatalf("Head = %q, want 7-hex short hash", res.Head)
	}
	if len(res.Unstaged) != 2 { // the .M record and the untracked file
		t.Fatalf("Unstaged = %+v", res.Unstaged)
	}
	// Both the modified and the untracked file are unstaged; the untracked
	// one carries ?/? columns.
	var untracked *git.Entry
	for i := range res.Unstaged {
		if res.Unstaged[i].Path == "untracked.txt" {
			untracked = &res.Unstaged[i]
		}
	}
	if untracked == nil || untracked.X != '?' || untracked.Y != '?' {
		t.Fatalf("untracked entry = %+v", res.Unstaged)
	}
}

func TestParseRenameTwoPaths(t *testing.T) {
	res := parse(t, statusRename, 5000)
	if res.Total != 1 {
		t.Fatalf("Total = %d, want 1 (a rename is one record)", res.Total)
	}
	if len(res.Staged) != 1 {
		t.Fatalf("Staged = %+v", res.Staged)
	}
	e := res.Staged[0]
	// The entry's path is the header's embedded path — the current one.
	if e.Path != "renamed.txt" {
		t.Fatalf("rename entry path = %q, want renamed.txt", e.Path)
	}
	if e.X != 'R' || e.Y != '.' {
		t.Fatalf("rename entry = %+v", e)
	}
}

func TestParsePathWithNewline(t *testing.T) {
	res := parse(t, statusNewline, 5000)
	if res.Total != 1 {
		t.Fatalf("Total = %d, want 1", res.Total)
	}
	if len(res.Unstaged) != 1 || res.Unstaged[0].Path != "we\nird.txt" {
		t.Fatalf("Unstaged = %+v", res.Unstaged)
	}
}

func TestParseFileInBothLists(t *testing.T) {
	res := parse(t, statusBoth, 5000)
	if res.Total != 1 {
		t.Fatalf("Total = %d, want 1", res.Total)
	}
	if len(res.Staged) != 1 || len(res.Unstaged) != 1 {
		t.Fatalf("Staged=%+v Unstaged=%+v — one record must land in both lists", res.Staged, res.Unstaged)
	}
	if res.Staged[0].Path != "f.txt" || res.Staged[0].X != 'M' || res.Staged[0].Y != 'M' {
		t.Fatalf("entry = %+v", res.Staged[0])
	}
}

func TestParseConflictRecord(t *testing.T) {
	res := parse(t, statusConflict, 5000)
	if res.Total != 1 {
		t.Fatalf("Total = %d, want 1", res.Total)
	}
	if len(res.Conflicted) != 1 {
		t.Fatalf("Conflicted = %+v", res.Conflicted)
	}
	e := res.Conflicted[0]
	if e.Path != "f.txt" || e.X != 'U' || e.Y != 'U' {
		t.Fatalf("conflict entry = %+v", e)
	}
	if len(res.Staged) != 0 || len(res.Unstaged) != 0 {
		t.Fatalf("a conflict must not land in Staged or Unstaged: %+v %+v", res.Staged, res.Unstaged)
	}
}

func TestParseUpstreamAndAheadBehind(t *testing.T) {
	res := parse(t, statusUpstream, 5000)
	if res.Upstream != "origin/master" {
		t.Fatalf("Upstream = %q", res.Upstream)
	}
	if res.Ahead != 1 || res.Behind != 0 {
		t.Fatalf("Ahead=%d Behind=%d, want 1, 0", res.Ahead, res.Behind)
	}
	if res.Total != 0 {
		t.Fatalf("Total = %d, want 0", res.Total)
	}
}

func TestParseNoUpstreamIsAbsenceNotZero(t *testing.T) {
	// The statusUpstream fixture's branch has an upstream; statusDetached's
	// does not, and nothing in the stream says so — the absence of
	// # branch.upstream is the fact.
	res := parse(t, statusDetached, 5000)
	if res.Upstream != "" {
		t.Fatalf("Upstream = %q, want empty", res.Upstream)
	}
}

func TestParseStreamingAcrossWrites(t *testing.T) {
	// Writes may split a record anywhere, including inside the NUL-delimited
	// fields and inside the path.
	p := NewParser(5000)
	for i := 0; i < len(statusRename); {
		end := i + 7
		if end > len(statusRename) {
			end = len(statusRename)
		}
		if err := p.Write([]byte(statusRename[i:end])); err != nil {
			t.Fatalf("Write at %d: %v", i, err)
		}
		i = end
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 1 || len(res.Staged) != 1 || res.Staged[0].Path != "renamed.txt" {
		t.Fatalf("streamed parse = %+v", res)
	}
}

func TestParseCappedKeepsCounting(t *testing.T) {
	// Retention stops at max; counting continues, so Total is exact while the
	// lists hold only the prefix. This is what lets local report capped.
	const max = 3
	stream := statusUnborn + statusUnborn + statusUnborn + statusUnborn // 4 records
	res := parse(t, stream, max)
	if res.Total != 4 {
		t.Fatalf("Total = %d, want 4", res.Total)
	}
	if len(res.Staged) != max {
		t.Fatalf("retained %d staged entries, want %d", len(res.Staged), max)
	}
}

func TestParseCutBelowRecordCapIsCompleteShaped(t *testing.T) {
	// A traversal cut below the record cap leaves a result that looks
	// complete: every observed record is in the lists and Total < cap. The
	// completeness discriminator is the execution's cut flag, not anything
	// in the parser — the two-boolean design got exactly this state wrong.
	res := parse(t, statusBoth, 5000)
	if res.Total >= 5000 {
		t.Fatalf("fixture must be below the cap, Total=%d", res.Total)
	}
	if len(res.Staged) != 1 || len(res.Unstaged) != 1 {
		t.Fatalf("all observed records must be retained: %+v", res)
	}
}

func TestParseEmptyListsNeverNil(t *testing.T) {
	res := parse(t, statusUpstream, 5000)
	if res.Staged == nil || res.Unstaged == nil || res.Conflicted == nil {
		t.Fatal("empty lists must be [], never nil — the contract-schema bug")
	}
}

func TestParseDropsInterruptedTrailingField(t *testing.T) {
	// git's -z output terminates every record; a stream cut mid-record ends
	// in a partial field that is not a record and must not be counted.
	stream := statusUnborn[:len(statusUnborn)-3] // cut inside "f.txt\0"
	p := NewParser(5000)
	if err := p.Write([]byte(stream)); err != nil {
		t.Fatal(err)
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 0 {
		t.Fatalf("Total = %d, want 0 — a partial record is not a record", res.Total)
	}
}

func TestParseMalformedRecordErrors(t *testing.T) {
	p := NewParser(5000)
	if err := p.Write([]byte("9 nonsense\x00")); err == nil {
		t.Fatal("malformed record accepted")
	}
	if err := p.Write([]byte("1 XX N... 100644\x00")); err == nil {
		t.Fatal("truncated tracked record accepted")
	}
	if err := p.Write([]byte("u UU N... 100644\x00")); err == nil {
		t.Fatal("truncated conflict record accepted")
	}
}

func TestParsePathWithSpaces(t *testing.T) {
	// The path is the rejoined remainder of the header field, so internal
	// spaces — including consecutive ones — survive.
	stream := "# branch.oid (initial)\x00# branch.head master\x00" +
		"? my  dir/file with spaces.txt\x00"
	res := parse(t, stream, 5000)
	if len(res.Unstaged) != 1 || res.Unstaged[0].Path != "my  dir/file with spaces.txt" {
		t.Fatalf("Unstaged = %+v", res.Unstaged)
	}
}

func TestLiteralPathspec(t *testing.T) {
	// A path git reports verbatim must stage as itself, not as a glob.
	if got := LiteralPathspec("a*b[c].go"); got != ":(literal)a*b[c].go" {
		t.Fatalf("LiteralPathspec = %q", got)
	}
}

// Every form carries --no-ext-diff, and the behavioural proof that this
// matters is TestDiffIgnoresExternalDiffDriver in the local package: a user
// with diff.external configured otherwise gets that program's output instead
// of a unified diff, which the panel would decorate as though it were one.
func TestDiffArgsForms(t *testing.T) {
	cases := []struct {
		side git.Side
		want []string
	}{
		{git.SideStaged, []string{"diff", "--no-ext-diff", "--cached", "--no-color", "--", "f.go"}},
		{git.SideUnstaged, []string{"diff", "--no-ext-diff", "--no-color", "--", "f.go"}},
		{git.SideUntracked, []string{
			"diff", "--no-ext-diff", "--no-index", "--no-color", "--", "/dev/null", "f.go",
		}},
	}
	for _, c := range cases {
		got, err := DiffArgs(c.side, "f.go")
		if err != nil {
			t.Fatalf("%s: %v", c.side, err)
		}
		if strings.Join(got, "\x00") != strings.Join(c.want, "\x00") {
			t.Fatalf("%s: got %v want %v", c.side, got, c.want)
		}
	}
	if _, err := DiffArgs(git.Side("other"), "f.go"); err == nil {
		t.Fatal("unknown side accepted")
	}
}

func TestCommitArgsAmend(t *testing.T) {
	if got := strings.Join(CommitArgs(false), " "); got != "commit -F -" {
		t.Fatalf("CommitArgs(false) = %q", got)
	}
	if got := strings.Join(CommitArgs(true), " "); got != "commit -F - --amend" {
		t.Fatalf("CommitArgs(true) = %q", got)
	}
}

// TestStatusArgsIsPollSafe pins --no-optional-locks, and it is first in the
// argv because it is a git-level option rather than a status one. The
// behavioural proof is TestStatusDoesNotRewriteTheIndex in the local package:
// without it, a plain status rewrites .git/index, so the panel would mutate
// the repository it is only supposed to be reading, every few seconds, while
// an agent works in the same tree.
func TestStatusArgsIsPollSafe(t *testing.T) {
	got := StatusArgs()
	if len(got) == 0 || got[0] != "--no-optional-locks" {
		t.Fatalf("StatusArgs does not lead with --no-optional-locks: %v", got)
	}
	want := []string{
		"--no-optional-locks",
		"status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all",
	}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("StatusArgs = %v want %v", got, want)
	}
}
