package sessionruntime

import (
	"strings"
	"testing"
)

// A MARKER SPLIT ACROSS TWO PTY READS IS LOCATED WHERE IT ENDS
// (nocx-2v80t.8).
//
// Ingest feeds the emulator up to each marker in its own call, so the screen
// read at the marker is the screen exactly as the marker left it. That split
// was searched for within one feed only: a marker whose first bytes ended one
// read and whose rest began the next was found by the emulator's own
// stateful scanner, but only after the WHOLE second feed was applied — the
// output that followed the mark, or the prompt that followed the fence, was
// already on the screen the marker's sighting read.
//
// Every case feeds the same bytes, split at every position inside the marker,
// and must store exactly what the unsplit feed stores.
func TestAnOutputMarkSplitAcrossTwoReadsIsLocatedWhereItEnds(t *testing.T) {
	head := "earlier\r\nearlier\r\n$ a-command\r\n"
	tail := "OUT-001\r\nOUT-002\r\nOUT-003\r\n"
	for cut := 0; cut <= len(outputMarkerFixed); cut++ {
		t.Run(strings.ReplaceAll(outputMarkerFixed[:cut], "\x1b", "ESC"), func(t *testing.T) {
			s, rs := streamSession(t, harnessGeometry(80, 24))
			if err := s.Ingest([]byte(head + outputMarkerFixed[:cut])); err != nil {
				t.Fatalf("first read: %v", err)
			}
			if err := s.Ingest([]byte(outputMarkerFixed[cut:] + tail)); err != nil {
				t.Fatalf("second read: %v", err)
			}
			nonce := obsNonce(0x81)
			s.Completed(s.Incarnation(), nonce, 0)
			if err := s.Ingest([]byte(fenceFor(0x81))); err != nil {
				t.Fatalf("ingest the fence: %v", err)
			}
			if got := storedRowsFor(t, rs, nonce); strings.Join(got, "|") != "OUT-001|OUT-002|OUT-003" {
				t.Fatalf("the block stored %q, want exactly OUT-001, OUT-002, OUT-003", got)
			}
		})
	}
}

func TestAFenceSplitAcrossTwoReadsClosesOnItsOwnScreen(t *testing.T) {
	fence := fenceFor(0x82)
	prompt := "\x1b]133;D;0\x07\x1b]133;A\x07next-prompt$ "
	for _, cut := range []int{1, 5, len(fenceMarkerPrefix), len(fenceMarkerPrefix) + 10, len(fence) - 1} {
		t.Run(strings.ReplaceAll(fence[:cut], "\x1b", "ESC"), func(t *testing.T) {
			s, rs := streamSession(t, harnessGeometry(80, 24))
			if err := s.Ingest([]byte("$ a-command\r\n" + outputMarkerFixed + "OUT-001\r\nOUT-002\r\n")); err != nil {
				t.Fatalf("ingest the command: %v", err)
			}
			nonce := obsNonce(0x82)
			s.Completed(s.Incarnation(), nonce, 0)
			if err := s.Ingest([]byte(fence[:cut])); err != nil {
				t.Fatalf("first read: %v", err)
			}
			if err := s.Ingest([]byte(fence[cut:] + prompt)); err != nil {
				t.Fatalf("second read: %v", err)
			}
			if got := storedRowsFor(t, rs, nonce); strings.Join(got, "|") != "OUT-001|OUT-002" {
				t.Fatalf("the block stored %q, want exactly OUT-001, OUT-002", got)
			}
		})
	}
}
