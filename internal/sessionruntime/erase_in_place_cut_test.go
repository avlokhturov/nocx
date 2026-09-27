package sessionruntime

import (
	"strings"
	"testing"
)

// A COMMAND THAT CLEARS THE SCREEN IN PLACE KEEPS ITS WHOLE OUTPUT
// (nocx-2v80t.7).
//
// The closing screen's cut removes the rows above the command's own first
// output row — its prompt and echoed command line — by the position the
// output mark measured. An in-place erase (CSI 2 J, what `clear` and redraw
// loops emit) blanks those rows without any of them leaving the screen, and
// the command then prints from the top: the rows the cut would remove are the
// command's own output now. Measured before the fix: the first rows of the
// output were missing from the block, as many as the prefix was tall.
func TestACommandThatClearsTheScreenInPlaceKeepsItsWholeOutput(t *testing.T) {
	for _, erase := range []string{"\x1b[H\x1b[2J", "\x1b[2J\x1b[H"} {
		t.Run(strings.ReplaceAll(erase, "\x1b", "ESC"), func(t *testing.T) {
			s, rs := streamSession(t, harnessGeometry(80, 24))
			if err := s.Ingest([]byte("earlier\r\nearlier\r\n$ clear-then-print\r\n" + outputMarkerFixed + erase + "OUT-001\r\nOUT-002\r\nOUT-003\r\n")); err != nil {
				t.Fatalf("ingest: %v", err)
			}
			nonce := obsNonce(0x71)
			s.Completed(s.Incarnation(), nonce, 0)
			if err := s.Ingest([]byte(fenceFor(0x71))); err != nil {
				t.Fatalf("ingest the fence: %v", err)
			}
			if got := storedRowsFor(t, rs, nonce); strings.Join(got, "|") != "OUT-001|OUT-002|OUT-003" {
				t.Fatalf("the block stored %q, want exactly OUT-001, OUT-002, OUT-003", got)
			}
		})
	}
}

// Output that reads like the prompt it replaced is output (codex's review of
// nocx-2v80t.7): after an in-place erase the sighting itself says the prompt
// is gone, whatever the rows now read; without an erase, output written over
// the prompt is told from it by its text, spaces included.
func TestOutputThatReadsLikeTheErasedPromptIsKept(t *testing.T) {
	for _, tc := range []struct{ name, over, first string }{
		{"erased, then the prompt's text without its space", "\x1b[H\x1b[2J", "$command"},
		{"erased, then the prompt's exact text", "\x1b[H\x1b[2J", "$ command"},
		{"written over without an erase, the space missing", "\x1b[H", "$command"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, rs := streamSession(t, harnessGeometry(80, 24))
			if err := s.Ingest([]byte("$ command\r\n" + outputMarkerFixed + tc.over + tc.first + "\x1b[K\r\nOUT-002\r\n")); err != nil {
				t.Fatalf("ingest: %v", err)
			}
			nonce := obsNonce(0x72)
			s.Completed(s.Incarnation(), nonce, 0)
			if err := s.Ingest([]byte(fenceFor(0x72))); err != nil {
				t.Fatalf("ingest the fence: %v", err)
			}
			if got := storedRowsFor(t, rs, nonce); strings.Join(got, "|") != tc.first+"|OUT-002" {
				t.Fatalf("the block stored %q, want exactly %q, OUT-002", got, tc.first)
			}
		})
	}
}
