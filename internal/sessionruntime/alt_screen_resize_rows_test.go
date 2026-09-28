package sessionruntime

import (
	"fmt"
	"strings"
	"testing"
)

// ROWS SCROLLED BY LEAVING THE ALTERNATE SCREEN ARE NOT LOST AFTER A COMMIT
// MADE WHILE IT WAS UP (nocx-2v80t.6).
//
// A commit while the alternate screen holds the pane leaves the primary's
// departure count unmeasured — its depth cannot be read from there — and the
// feed that leaves the alternate screen and prints more than a screen used to
// re-baseline over its own scroll: those rows were neither streamed nor
// counted as withheld. Measured before the fix: 21 of 60 rows stored. The
// same bytes with no commit store all 60, which is the pair.
func TestLeavingTheAlternateScreenAfterACommitKeepsEveryRowItScrolls(t *testing.T) {
	for _, commit := range []bool{false, true} {
		name := "no commit while the alternate screen is up"
		if commit {
			name = "a commit while the alternate screen is up"
		}
		t.Run(name, func(t *testing.T) {
			s, rs := streamSession(t, harnessGeometry(150, 40))
			if err := s.Ingest([]byte("$ run-a-program\r\n" + outputMarkerFixed)); err != nil {
				t.Fatalf("ingest the echo and the output mark: %v", err)
			}
			if err := s.Ingest([]byte("\x1b[?1049h" + "full-screen program\r\n")); err != nil {
				t.Fatalf("enter the alternate screen: %v", err)
			}
			if commit {
				if _, err := s.CommitGeometry(harnessGeometry(80, 24)); err != nil {
					t.Fatalf("commit: %v", err)
				}
			}
			var want []string
			var out strings.Builder
			out.WriteString("\x1b[?1049l")
			for i := 1; i <= 60; i++ {
				m := fmt.Sprintf("OUT-%03d", i)
				want = append(want, m)
				out.WriteString(m + "\r\n")
			}
			if err := s.Ingest([]byte(out.String())); err != nil {
				t.Fatalf("leave the alternate screen and print in one feed: %v", err)
			}
			nonce := obsNonce(0x61)
			s.Completed(s.Incarnation(), nonce, 0)
			if err := s.Ingest([]byte(fenceFor(0x61))); err != nil {
				t.Fatalf("ingest the fence: %v", err)
			}
			var stored []string
			for _, e := range rs.snapshot() {
				if e.kind == "rows" {
					for _, r := range e.rows {
						stored = append(stored, streamRowText(r))
					}
				}
			}
			stored = append(stored, closingTexts(t, rs, nonce)...)
			if strings.Join(stored, "|") != strings.Join(want, "|") {
				t.Fatalf("the block stored %d rows, want exactly its %d output rows:\n%s", len(stored), len(want), strings.Join(stored, "\n"))
			}
		})
	}
}

// The other half of the same schedule: output the command printed BEFORE the
// alternate screen, on a full primary screen, is pushed into the history by
// a shrink while the alternate screen is up. Those rows left the screen too,
// and are the block's.
func TestAShrinkWhileTheAlternateScreenIsUpKeepsTheRowsItPushedOff(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(150, 40))
	var want []string
	var out strings.Builder
	out.WriteString("$ make-then-open-a-program\r\n" + outputMarkerFixed)
	for i := 1; i <= 50; i++ {
		m := fmt.Sprintf("OUT-%03d", i)
		want = append(want, m)
		out.WriteString(m + "\r\n")
	}
	if err := s.Ingest([]byte(out.String())); err != nil {
		t.Fatalf("ingest the command and its output: %v", err)
	}
	if err := s.Ingest([]byte("\x1b[?1049h" + "full-screen program\r\n")); err != nil {
		t.Fatalf("enter the alternate screen: %v", err)
	}
	if _, err := s.CommitGeometry(harnessGeometry(150, 24)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := s.Ingest([]byte("\x1b[?1049l")); err != nil {
		t.Fatalf("leave the alternate screen: %v", err)
	}
	nonce := obsNonce(0x62)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x62))); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	var stored []string
	for _, e := range rs.snapshot() {
		if e.kind == "rows" {
			for _, r := range e.rows {
				stored = append(stored, streamRowText(r))
			}
		}
	}
	stored = append(stored, closingTexts(t, rs, nonce)...)
	if strings.Join(stored, "|") != strings.Join(want, "|") {
		t.Fatalf("the block stored %d rows, want exactly its %d output rows:\n%s", len(stored), len(want), strings.Join(stored, "\n"))
	}
}

// A window row that continues the one before it is consumed as ITSELF when it
// departs, so no entry outlives the row it named: output whose first row
// reads exactly like that continuation is output (codex's review of
// nocx-2v80t.6, finding 3).
func TestAContinuationTheWindowNamedLeavesNoEntryToSwallowOutput(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(80, 24))
	line := "$ " + strings.Repeat("x", 78) + strings.Repeat("continuation-text ", 2)
	if err := s.Ingest([]byte(line + "\r\n" + outputMarkerFixed)); err != nil {
		t.Fatalf("ingest the echo and the output mark: %v", err)
	}
	tail := strings.TrimRight(line[80:], " ")
	want := []string{tail}
	var out strings.Builder
	out.WriteString(tail + "\r\n")
	for i := 1; i <= 40; i++ {
		m := fmt.Sprintf("OUT-%03d", i)
		want = append(want, m)
		out.WriteString(m + "\r\n")
	}
	if err := s.Ingest([]byte(out.String())); err != nil {
		t.Fatalf("ingest the output: %v", err)
	}
	nonce := obsNonce(0x63)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x63))); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	got := storedRowsFor(t, rs, nonce)
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("the block stored %d rows, want its %d output rows, the first reading like the echo's continuation:\n%s", len(got), len(want), strings.Join(got, "\n"))
	}
}

// A pane that GROWS while the alternate screen is up pulls rows the primary
// already reported back out of its history. When they leave again they are
// not the next command's: the next block holds only its own output (codex's
// review of nocx-2v80t.6, finding 4).
func TestAGrowthWhileTheAlternateScreenIsUpDoesNotReportRowsTwice(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(80, 24))
	obsFeed(t, s, 0, 60)
	obsSeal(t, s, obsNonce(1))
	if err := s.Ingest([]byte("$ run-a-program\r\n" + outputMarkerFixed + "\x1b[?1049h" + "full-screen program\r\n")); err != nil {
		t.Fatalf("enter the alternate screen: %v", err)
	}
	if _, err := s.CommitGeometry(harnessGeometry(80, 40)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	var want []string
	var out strings.Builder
	out.WriteString("\x1b[?1049l")
	for i := 1; i <= 60; i++ {
		m := fmt.Sprintf("OUT-%03d", i)
		want = append(want, m)
		out.WriteString(m + "\r\n")
	}
	if err := s.Ingest([]byte(out.String())); err != nil {
		t.Fatalf("leave the alternate screen and print: %v", err)
	}
	nonce := obsNonce(0x64)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x64))); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	// The block before is every row streamed up to its end marker; this one
	// is what streamed after it plus its own closing screen.
	var mine []string
	after := false
	for _, e := range rs.snapshot() {
		switch {
		case e.kind == "end" && e.nonce == obsNonce(1):
			after = true
		case e.kind == "rows" && after:
			for _, r := range e.rows {
				mine = append(mine, streamRowText(r))
			}
		}
	}
	mine = append(mine, closingTexts(t, rs, nonce)...)
	if strings.Join(mine, "|") != strings.Join(want, "|") {
		t.Fatalf("the block stored %d rows, want exactly its %d output rows:\n%s", len(mine), len(want), strings.Join(mine, "\n"))
	}
}
