package sessionruntime

import (
	"fmt"
	"strings"
	"testing"
)

// A COMMAND LINE IS NOT OUTPUT AFTER THE PANE CHANGES WIDTH (nocx-2v80t.5).
//
// When the last window detaches, the session returns to the default 80x24
// (internal/session/size.go). A command typed at the window's own width, whose
// output starts only after that, had its echoed command line stored as its
// first output rows: the narrower grid reflows the echo into more rows than
// the output mark's sighting saw, and those rows were streamed as the block's.
// The same holds for any geometry commit between the output mark and the
// output: another window attaching, a font or zoom change, a manual resize.
//
// Every case drives the same shape of bytes; what differs is the geometry the
// pane holds when the command is typed, the commits between the output mark
// and the output, and how much output there is. The block's stored rows —
// every row streamed for the interval plus its closing screen — must be
// exactly the command's output in each: a long run scrolls the echo off the
// screen (the suppression window's case), a short one never scrolls it (the
// closing screen's bound's case).
func TestACommandLineIsNotStoredAsOutputWhenThePaneChangesWidthBeforeTheOutput(t *testing.T) {
	cases := []struct {
		name    string
		typedAt Geometry
		commits []Geometry
		lines   int
	}{
		{"the pane keeps its width, a long run", harnessGeometry(150, 40), nil, 60},
		{"the pane narrows to the detached default, a long run", harnessGeometry(150, 40), []Geometry{harnessGeometry(80, 24)}, 60},
		{"the pane narrows, a run that never scrolls", harnessGeometry(150, 40), []Geometry{harnessGeometry(80, 24)}, 3},
		{"the pane widens and joins the wrapped line, a long run", harnessGeometry(80, 24), []Geometry{harnessGeometry(200, 40)}, 60},
		{"the pane widens, a run that never scrolls", harnessGeometry(80, 24), []Geometry{harnessGeometry(200, 40)}, 3},
		{"two commits in a row, a long run", harnessGeometry(150, 40), []Geometry{harnessGeometry(80, 24), harnessGeometry(60, 30)}, 60},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, rs := streamSession(t, c.typedAt)

			// A prompt and a typed command line long enough to soft-wrap at
			// the width it is typed at, as a shell's own echo writes it.
			line := "$ " + strings.Repeat("printf-a-long-command-line ", 7)
			if err := s.Ingest([]byte(line + "\r\n")); err != nil {
				t.Fatalf("ingest the echoed command line: %v", err)
			}
			if err := s.Ingest([]byte(outputMarkerFixed)); err != nil {
				t.Fatalf("ingest the output mark: %v", err)
			}
			for _, g := range c.commits {
				if _, err := s.CommitGeometry(g); err != nil {
					t.Fatalf("commit %dx%d: %v", g.Cols, g.Rows, err)
				}
			}
			var want []string
			var out strings.Builder
			for i := 1; i <= c.lines; i++ {
				m := fmt.Sprintf("OUT-%03d", i)
				want = append(want, m)
				out.WriteString(m + "\r\n")
			}
			if err := s.Ingest([]byte(out.String())); err != nil {
				t.Fatalf("ingest the output: %v", err)
			}
			nonce := obsNonce(0x51)
			s.Completed(s.Incarnation(), nonce, 0)
			if err := s.Ingest([]byte(fenceFor(0x51))); err != nil {
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
				t.Fatalf("the block stored %d rows, want exactly its %d output rows:\n%s",
					len(stored), len(want), strings.Join(stored, "\n"))
			}
		})
	}
}

// Paired: output that repeats the command line's own text after a commit is
// output, and stays. The repair works on row identity, so a row that merely
// READS like the echo is not taken for it.
func TestOutputThatRepeatsTheCommandLineIsKeptAfterTheSessionNarrows(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(150, 40))
	line := "$ " + strings.Repeat("printf-a-long-command-line ", 7)
	if err := s.Ingest([]byte(line + "\r\n" + outputMarkerFixed)); err != nil {
		t.Fatalf("ingest the echo and the output mark: %v", err)
	}
	if _, err := s.CommitGeometry(harnessGeometry(80, 24)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	var out strings.Builder
	out.WriteString(line + "\r\n")
	for i := 1; i <= 40; i++ {
		fmt.Fprintf(&out, "OUT-%03d\r\n", i)
	}
	if err := s.Ingest([]byte(out.String())); err != nil {
		t.Fatalf("ingest the output: %v", err)
	}
	nonce := obsNonce(0x52)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x52))); err != nil {
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
	// The output's own copy of the line wraps into three rows at 80 columns.
	if len(stored) != 43 || !strings.HasPrefix(stored[0], "$ printf-a-long-command-line") || stored[3] != "OUT-001" {
		t.Fatalf("the block stored %d rows starting %q, want the repeated line's 3 rows then 40 markers:\n%s",
			len(stored), stored[0], strings.Join(stored, "\n"))
	}
}

// storedRowsFor is every row streamed so far plus the interval's closing
// screen, as text, in order: what the block stores.
func storedRowsFor(t *testing.T, rs *recordingRowStream, nonce FenceNonce) []string {
	t.Helper()
	var stored []string
	for _, e := range rs.snapshot() {
		if e.kind == "rows" {
			for _, r := range e.rows {
				stored = append(stored, streamRowText(r))
			}
		}
	}
	return append(stored, closingTexts(t, rs, nonce)...)
}

// A commit while a full-screen program holds the alternate screen re-lays the
// primary screen's rows where no pin can be located. The repair is owed until
// the primary is back, never skipped and never guessed as "the prefix left"
// (codex review of nocx-2v80t.5, finding 1).
func TestACommitWhileTheAlternateScreenIsUpStillKeepsTheCommandLineOutOfTheBlock(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(150, 40))
	line := "$ " + strings.Repeat("printf-a-long-command-line ", 7)
	if err := s.Ingest([]byte(line + "\r\n" + outputMarkerFixed)); err != nil {
		t.Fatalf("ingest the echo and the output mark: %v", err)
	}
	if err := s.Ingest([]byte("\x1b[?1049h" + "full-screen program\r\n")); err != nil {
		t.Fatalf("enter the alternate screen: %v", err)
	}
	if _, err := s.CommitGeometry(harnessGeometry(80, 24)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := s.Ingest([]byte("\x1b[?1049l" + "OUT-001\r\nOUT-002\r\n")); err != nil {
		t.Fatalf("leave the alternate screen and print: %v", err)
	}
	nonce := obsNonce(0x53)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x53))); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	if got := storedRowsFor(t, rs, nonce); strings.Join(got, "|") != "OUT-001|OUT-002" {
		t.Fatalf("the block stored %d rows, want exactly OUT-001, OUT-002:\n%s", len(got), strings.Join(got, "\n"))
	}
}

// A sighting nobody has authenticated yet holds its own window and keeps the
// one it replaced (the output mark's) to put back. A commit in that gap
// re-lays the rows BOTH name, so the one kept aside is repaired too: when
// output gives the held rows back, the command line is still recognised as
// the command line (codex review of nocx-2v80t.5, finding 2).
func TestACommitWhileASightingHoldsItsWindowRepairsTheWindowItKeptAside(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(150, 40))
	line := "$ " + strings.Repeat("printf-a-long-command-line ", 7)
	if err := s.Ingest([]byte(line + "\r\n" + outputMarkerFixed)); err != nil {
		t.Fatalf("ingest the echo and the output mark: %v", err)
	}
	forged := obsNonce(9)
	if err := s.SightFence(forged, []byte("fence-source")); err != nil {
		t.Fatalf("sight a fence nobody will authenticate: %v", err)
	}
	if _, err := s.CommitGeometry(harnessGeometry(80, 24)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	var want []string
	var out strings.Builder
	for i := 1; i <= 60; i++ {
		m := fmt.Sprintf("OUT-%03d", i)
		want = append(want, m)
		out.WriteString(m + "\r\n")
	}
	if err := s.Ingest([]byte(out.String())); err != nil {
		t.Fatalf("ingest the output: %v", err)
	}
	if err := s.ExpireRendezvous(forged); err != nil {
		t.Fatalf("expire the forged fence's meeting: %v", err)
	}
	nonce := obsNonce(0x54)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x54))); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	if got := storedRowsFor(t, rs, nonce); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("the block stored %d rows, want exactly its %d output rows:\n%s", len(got), len(want), strings.Join(got, "\n"))
	}
}

// The output mark's pin belongs to its interval. A sighting nobody
// authenticates splits the interval and the tail may sight a C of its own;
// when the split is undone, the interval gets ITS pin back, so a later commit
// re-measures its own output start and not the tail's (codex review of
// nocx-2v80t.5, finding 3).
func TestAnUndoneSplitGivesTheIntervalItsOwnOutputStartPinBack(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(150, 40))
	line := "$ " + strings.Repeat("printf-a-long-command-line ", 7)
	if err := s.Ingest([]byte("earlier\r\nearlier\r\nearlier\r\n" + line + "\r\n" + outputMarkerFixed)); err != nil {
		t.Fatalf("ingest the echo and the output mark: %v", err)
	}
	forged := obsNonce(9)
	if err := s.SightFence(forged, []byte("fence-source")); err != nil {
		t.Fatalf("sight a fence nobody will authenticate: %v", err)
	}
	// The rebased tail prints a row and sights a C of its own below it: a
	// nested command's preexec. Its pin is a row lower than the interval's.
	if err := s.Ingest([]byte("tail-row\r\n" + outputMarkerFixed)); err != nil {
		t.Fatalf("ingest the tail's output mark: %v", err)
	}
	if err := s.ExpireRendezvous(forged); err != nil {
		t.Fatalf("expire the forged fence's meeting: %v", err)
	}
	if _, err := s.CommitGeometry(harnessGeometry(80, 24)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := s.Ingest([]byte("OUT-001\r\nOUT-002\r\n")); err != nil {
		t.Fatalf("ingest the output: %v", err)
	}
	nonce := obsNonce(0x55)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x55))); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	// The split was undone, so everything after the interval's own output
	// mark is its output, the tail's row included.
	if got := storedRowsFor(t, rs, nonce); strings.Join(got, "|") != "tail-row|OUT-001|OUT-002" {
		t.Fatalf("the block stored %d rows, want exactly tail-row, OUT-001, OUT-002:\n%s", len(got), strings.Join(got, "\n"))
	}
}

// The feed that brings the primary screen back can also scroll it: the
// program exits the alternate screen and prints more than a screen in one
// chunk, so the command line's re-laid rows leave in the same report the
// owed repair runs for (codex's second review of nocx-2v80t.5, finding 1).
func TestTheFeedThatLeavesTheAlternateScreenAndScrollsStillKeepsTheCommandLineOut(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(150, 40))
	line := "$ " + strings.Repeat("printf-a-long-command-line ", 7)
	if err := s.Ingest([]byte(line + "\r\n" + outputMarkerFixed)); err != nil {
		t.Fatalf("ingest the echo and the output mark: %v", err)
	}
	if err := s.Ingest([]byte("\x1b[?1049h" + "full-screen program\r\n")); err != nil {
		t.Fatalf("enter the alternate screen: %v", err)
	}
	if _, err := s.CommitGeometry(harnessGeometry(80, 24)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	var want []string
	var out strings.Builder
	out.WriteString("\x1b[?1049l")
	for i := 1; i <= 40; i++ {
		m := fmt.Sprintf("OUT-%03d", i)
		want = append(want, m)
		out.WriteString(m + "\r\n")
	}
	if err := s.Ingest([]byte(out.String())); err != nil {
		t.Fatalf("leave the alternate screen and print in one feed: %v", err)
	}
	nonce := obsNonce(0x56)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x56))); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	// What this schedule judges is that no row of the command line is stored.
	// That every output row arrives is a separate defect of the same schedule:
	// a commit while the alternate screen is up loses the rows the exiting
	// feed scrolls, on main before this change too (nocx-2v80t.6). So the
	// stored rows are held to being output rows, in order, ending at the last.
	got := storedRowsFor(t, rs, nonce)
	if len(got) == 0 || got[len(got)-1] != want[len(want)-1] {
		t.Fatalf("the block stored %d rows, want them to end at %s:\n%s", len(got), want[len(want)-1], strings.Join(got, "\n"))
	}
	if tail := want[len(want)-len(got):]; strings.Join(got, "|") != strings.Join(tail, "|") {
		t.Fatalf("the block stored rows that are not its output, in order:\n%s", strings.Join(got, "\n"))
	}
}

// A commit while a split is pending, then the split undone: the interval's
// cut is read from its own pin when it seals, so the commit in between is in
// the answer (codex's second review of nocx-2v80t.5, finding 2).
func TestACommitWhileASplitIsPendingIsInTheCutOnceTheSplitIsUndone(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(150, 40))
	line := "$ " + strings.Repeat("printf-a-long-command-line ", 7)
	if err := s.Ingest([]byte(line + "\r\n" + outputMarkerFixed)); err != nil {
		t.Fatalf("ingest the echo and the output mark: %v", err)
	}
	forged := obsNonce(9)
	if err := s.SightFence(forged, []byte("fence-source")); err != nil {
		t.Fatalf("sight a fence nobody will authenticate: %v", err)
	}
	if _, err := s.CommitGeometry(harnessGeometry(80, 24)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := s.ExpireRendezvous(forged); err != nil {
		t.Fatalf("expire the forged fence's meeting: %v", err)
	}
	if err := s.Ingest([]byte("OUT-001\r\nOUT-002\r\n")); err != nil {
		t.Fatalf("ingest the output: %v", err)
	}
	nonce := obsNonce(0x57)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x57))); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	if got := storedRowsFor(t, rs, nonce); strings.Join(got, "|") != "OUT-001|OUT-002" {
		t.Fatalf("the block stored %d rows, want exactly OUT-001, OUT-002:\n%s", len(got), strings.Join(got, "\n"))
	}
}

// A pane that grows pulls rows back out of the history ABOVE the command; the
// closing screen is cut from below them, and so is the output's own start
// (codex's third review of nocx-2v80t.5, finding 1).
func TestAGrowingPaneDoesNotCutTheCommandsOwnOutput(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(80, 27))
	obsFeed(t, s, 0, 60)
	obsSeal(t, s, obsNonce(1))
	if err := s.Ingest([]byte("$ a-command\r\n" + outputMarkerFixed + "OUT-001\r\nOUT-002\r\nOUT-003\r\n")); err != nil {
		t.Fatalf("ingest the command: %v", err)
	}
	if _, err := s.CommitGeometry(harnessGeometry(80, 33)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	nonce := obsNonce(0x58)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x58))); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	got := closingTexts(t, rs, nonce)
	if strings.Join(got, "|") != "OUT-001|OUT-002|OUT-003" {
		t.Fatalf("the closing screen holds %q, want exactly the three output rows", got)
	}
}

// A reset destroys the row the output mark was pinned on, and every row
// above it: what the command prints after it is all output (codex's third
// review of nocx-2v80t.5, finding 2).
func TestAResetAfterTheOutputMarkLeavesNothingToCut(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(80, 24))
	if err := s.Ingest([]byte("earlier\r\nearlier\r\n$ reset-then-print\r\n" + outputMarkerFixed + "\x1bc" + "OUT-001\r\nOUT-002\r\n")); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	nonce := obsNonce(0x59)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x59))); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	if got := closingTexts(t, rs, nonce); strings.Join(got, "|") != "OUT-001|OUT-002" {
		t.Fatalf("the closing screen holds %q, want exactly OUT-001, OUT-002", got)
	}
}

// Paired: the pane grew BEFORE the output mark, so rows pulled back from the
// history already sit above the command when the mark's row is pinned. The
// pin names the screen row itself, not its index below those rows.
func TestAnOutputMarkBelowPulledBackRowsPinsItsOwnRow(t *testing.T) {
	s, rs := streamSession(t, harnessGeometry(80, 27))
	obsFeed(t, s, 0, 60)
	obsSeal(t, s, obsNonce(1))
	if _, err := s.CommitGeometry(harnessGeometry(80, 33)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := s.Ingest([]byte("$ a-command\r\n" + outputMarkerFixed + "OUT-001\r\nOUT-002\r\n")); err != nil {
		t.Fatalf("ingest the command: %v", err)
	}
	nonce := obsNonce(0x5a)
	s.Completed(s.Incarnation(), nonce, 0)
	if err := s.Ingest([]byte(fenceFor(0x5a))); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	if got := closingTexts(t, rs, nonce); strings.Join(got, "|") != "OUT-001|OUT-002" {
		t.Fatalf("the closing screen holds %q, want exactly OUT-001, OUT-002", got)
	}
}
