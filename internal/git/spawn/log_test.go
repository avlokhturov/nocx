package spawn

import "testing"

// The streams below follow the record shape verified against git 2.55: one
// commit is six NUL-separated values (%H, %h, %s, %an, %aI, %D), the NUL
// after %D being the -z record terminator. A commit with no refs prints an
// empty %D — an empty SIXTH field — and the fixed field count is what keeps
// the records aligned.

const logHead = "5738d62b66777a78af894c0708d3a7e8798a4d8d\x005738d62\x00third\x00Test Author\x002026-08-07T12:52:40+03:00\x00HEAD -> main\x00"

const logTagged = "98c56f29de7a461cbbb7bc3a208a292972265b76\x0098c56f2\x00second subject\x00Test Author\x002026-08-07T12:52:40+03:00\x00tag: v1.0\x00"

// A subject may contain a newline and a tab — the whole reason -z exists —
// and the parser is NUL-delimited, never line-delimited.
const logHostile = "0fad36f6e4252ff2d21171131319626e290adda5\x000fad36f\x00sub\tject\nwith\nnewlines\x00A\xc3\xaf Author\x002026-08-07T12:52:40+03:00\x00origin/main\x00"

// The commit that follows a no-refs commit: its alignment proves the empty
// %D of the record before it did not shift the stream.
const logPlainAfter = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111\x00aaaa111\x00plain\x00Test Author\x002026-08-07T12:52:40+03:00\x00main\x00"

// logNoRefs is a commit with no decorations: %D is empty, so the record
// carries two NULs in a row — the separator after the date and the
// terminator that ends the empty %D field.
const logNoRefs = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222\x00bbbb222\x00no refs\x00Test Author\x002026-08-07T12:52:40+03:00\x00\x00"

func parseLog(t *testing.T, stream string, max int) LogResult {
	t.Helper()
	p := NewLogParser(max)
	if err := p.Write([]byte(stream)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	return res
}

func TestParseLogRecords(t *testing.T) {
	res := parseLog(t, logHead+logTagged, 50)
	if res.Total != 2 {
		t.Fatalf("Total = %d, want 2", res.Total)
	}
	if res.CutMidRecord {
		t.Fatal("clean stream reported cut")
	}
	head := res.Entries[0]
	if head.Hash != "5738d62b66777a78af894c0708d3a7e8798a4d8d" {
		t.Fatalf("Hash = %q", head.Hash)
	}
	if head.ShortHash != "5738d62" {
		t.Fatalf("ShortHash = %q", head.ShortHash)
	}
	if head.Subject != "third" {
		t.Fatalf("Subject = %q", head.Subject)
	}
	if head.AuthorName != "Test Author" {
		t.Fatalf("AuthorName = %q", head.AuthorName)
	}
	if head.AuthoredAt.Format("2006-01-02T15:04:05Z07:00") != "2026-08-07T12:52:40+03:00" {
		t.Fatalf("AuthoredAt = %v", head.AuthoredAt)
	}
	if len(head.Refs) != 1 || head.Refs[0] != "main" {
		t.Fatalf("Refs = %v, want [main] — HEAD -> stripped", head.Refs)
	}
	// Newest first: the stream's record order is the list order.
	if res.Entries[1].Subject != "second subject" {
		t.Fatalf("second entry Subject = %q", res.Entries[1].Subject)
	}
}

func TestParseLogSubjectWithNewlineAndTab(t *testing.T) {
	res := parseLog(t, logHostile, 50)
	if res.Total != 1 {
		t.Fatalf("Total = %d, want 1", res.Total)
	}
	if got := res.Entries[0].Subject; got != "sub\tject\nwith\nnewlines" {
		t.Fatalf("Subject = %q — a line-based parser would have shifted here", got)
	}
	if got := res.Entries[0].AuthorName; got != "A\u00ef Author" {
		t.Fatalf("AuthorName = %q — UTF-8 must survive", got)
	}
	if len(res.Entries[0].Refs) != 1 || res.Entries[0].Refs[0] != "origin/main" {
		t.Fatalf("Refs = %v", res.Entries[0].Refs)
	}
}

func TestParseLogCommitWithNoRefs(t *testing.T) {
	// A no-refs commit emits an empty %D (two NULs in a row); the record
	// AFTER it must still parse — the double-NUL must not shift the stream.
	res := parseLog(t, logNoRefs+logPlainAfter, 50)
	if res.Total != 2 {
		t.Fatalf("Total = %d, want 2", res.Total)
	}
	if got := res.Entries[0].Refs; len(got) != 0 {
		t.Fatalf("no-refs commit Refs = %v, want []", got)
	}
	if got := res.Entries[1].Subject; got != "plain" {
		t.Fatalf("record after a no-refs commit Subject = %q — misaligned stream", got)
	}
	if got := res.Entries[1].Refs; len(got) != 1 || got[0] != "main" {
		t.Fatalf("record after a no-refs commit Refs = %v, want [main]", got)
	}
}

func TestParseLogDetachedHeadRef(t *testing.T) {
	// A detached HEAD: %D is a bare HEAD, and the panel says it through the
	// refs (brief: detached HEAD works and must say so through the refs).
	const detached = "cccc3333cccc3333cccc3333cccc3333cccc3333\x00cccc333\x00detached\x00Test Author\x002026-08-07T12:52:40+03:00\x00HEAD\x00"
	res := parseLog(t, detached, 50)
	if got := res.Entries[0].Refs; len(got) != 1 || got[0] != "HEAD" {
		t.Fatalf("Refs = %v, want [HEAD]", got)
	}
}

func TestParseLogCappedKeepsCounting(t *testing.T) {
	// Retention stops at max; counting continues, so Total is exact while
	// the list holds only the prefix — the D9 shape local maps to capped.
	const max = 2
	res := parseLog(t, logHead+logTagged+logNoRefs+logPlainAfter, max)
	if res.Total != 4 {
		t.Fatalf("Total = %d, want 4", res.Total)
	}
	if len(res.Entries) != max {
		t.Fatalf("retained %d entries, want %d", len(res.Entries), max)
	}
}

func TestParseLogCutMidRecord(t *testing.T) {
	// The work ceiling cut the stream inside a record: the trailing partial
	// field is the cut signal, never a clean end.
	cut := logHead + logTagged[:len(logTagged)-10]
	p := NewLogParser(50)
	if err := p.Write([]byte(cut)); err != nil {
		t.Fatal(err)
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if !res.CutMidRecord {
		t.Fatal("stream interrupted mid-record reported clean")
	}
	if res.Total != 1 {
		t.Fatalf("Total = %d, want 1 — the partial record is not counted", res.Total)
	}
}

func TestParseLogCleanEndAfterCompleteRecord(t *testing.T) {
	// A stream that ends exactly at a record boundary is clean — the -z
	// terminator is present, so nothing is pending.
	res := parseLog(t, logHead+logNoRefs, 50)
	if res.CutMidRecord {
		t.Fatal("complete records reported cut")
	}
	if res.Total != 2 {
		t.Fatalf("Total = %d, want 2", res.Total)
	}
}

func TestParseLogEmptyStream(t *testing.T) {
	res := parseLog(t, "", 50)
	if res.Total != 0 {
		t.Fatalf("Total = %d, want 0", res.Total)
	}
	if res.Entries == nil {
		t.Fatal("entries must be [], never nil — the contract-schema bug")
	}
}

func TestParseLogMalformedAuthorDate(t *testing.T) {
	const bad = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111\x00aaaa111\x00subj\x00Author\x00not-a-date\x00main\x00"
	p := NewLogParser(50)
	if err := p.Write([]byte(bad)); err == nil {
		t.Fatal("unparseable author date accepted")
	}
}

func TestParseLogUnexpectedFieldShiftsStream(t *testing.T) {
	// A record carrying more than six values is a git whose grammar we do
	// not know: the first six still parse, and the overflow lands where
	// misalignment surfaces — a stream that never completes.
	const weird = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111\x00aaaa111\x00subj\x00Author\x002026-08-07T12:52:40+03:00\x00main\x00EXTRA\x00"
	res := parseLog(t, weird, 50)
	if !res.CutMidRecord {
		t.Fatal("overflow fields must surface as an interrupted stream, never as clean")
	}
}

func TestParseRefs(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"HEAD -> main, origin/main, tag: v1.0, HEAD", []string{"main", "origin/main", "v1.0", "HEAD"}},
		{"", []string{}},
		{"tag: v1.0", []string{"v1.0"}},
		{"HEAD", []string{"HEAD"}},
	}
	for _, c := range cases {
		if got := parseRefs(c.in); len(got) != len(c.want) {
			t.Fatalf("parseRefs(%q) = %v, want %v", c.in, got, c.want)
		} else {
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("parseRefs(%q) = %v, want %v", c.in, got, c.want)
				}
			}
		}
	}
}

func TestLogArgs(t *testing.T) {
	// --no-optional-locks first — a git-level option, like StatusArgs — so
	// the read never rewrites .git/index while an agent works in the tree.
	args := LogArgs(50)
	want := []string{
		"--no-optional-locks", "log", "-z",
		"--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%D",
		"-n", "51",
	}
	if len(args) != len(want) {
		t.Fatalf("LogArgs = %v, want %v", args, want)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("LogArgs = %v, want %v", args, want)
		}
	}
}
