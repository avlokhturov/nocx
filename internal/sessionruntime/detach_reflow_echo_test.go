package sessionruntime

import (
	"fmt"
	"strings"
	"testing"
)

// A COMMAND LINE IS NOT OUTPUT AFTER THE PANE NARROWS (nocx-2v80t.5).
//
// When the last window detaches, the session returns to the default 80x24
// (internal/session/size.go). A command typed at the window's own width, whose
// output starts only after that, had its echoed command line stored as its
// first output rows: the narrower grid reflows the echo into more rows than
// the output mark's sighting saw, and those rows were streamed as the block's.
//
// Both halves of the pair drive the same bytes; only the geometry commit
// between the output mark and the output differs. The block's stored rows —
// every row streamed for the interval plus its closing screen — must be
// exactly the command's output in both.
func TestACommandLineIsNotStoredAsOutputWhenThePaneNarrowsBeforeTheOutput(t *testing.T) {
	for _, narrow := range []bool{false, true} {
		name := "the pane keeps its width"
		if narrow {
			name = "the pane narrows to the detached default"
		}
		t.Run(name, func(t *testing.T) {
			s, rs := streamSession(t, harnessGeometry(150, 40))

			// A prompt and a typed command line long enough to soft-wrap at
			// 150 columns, as a shell's own echo writes it.
			line := "$ " + strings.Repeat("printf-a-long-command-line ", 7)
			if err := s.Ingest([]byte(line + "\r\n")); err != nil {
				t.Fatalf("ingest the echoed command line: %v", err)
			}
			if err := s.Ingest([]byte(outputMarkerFixed)); err != nil {
				t.Fatalf("ingest the output mark: %v", err)
			}
			if narrow {
				if _, err := s.CommitGeometry(harnessGeometry(80, 24)); err != nil {
					t.Fatalf("commit the detached default geometry: %v", err)
				}
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
