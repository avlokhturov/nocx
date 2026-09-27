package sessionruntime

import (
	"sort"

	"github.com/shady2k/nocx/internal/emulator"
)

// A GEOMETRY COMMIT RE-LAYS THE ROWS THE BOUNDARY BOOKKEEPING NAMES
// (nocx-2v80t.5).
//
// Two pieces of this runtime describe rows on the screen as they stood at an
// earlier instant: the suppression window (pendingScreen), which recognises a
// departing row by its CONTENT, and the output mark's position
// (observationOpen.OutputStartRow), which is a row INDEX. A width change
// re-lays every soft-wrapped line out, so after it both describe rows that no
// longer exist: a command line typed at 150 columns is three different rows at
// 80, none of which reads like either of the two the window holds, and the row
// the output starts at has moved down. Measured on the e2e: a command whose
// window closed before its output, the session returning to 80x24 on the
// detach, stored its own command line as its first three output rows.
//
// Both are repaired here, at the commit, from row IDENTITY — the
// [emulator.RowTrack] pins the window and the output mark already hold, which
// follow their rows through the reflow — never by re-matching text.

// reflowBoundaryLocked brings the suppression windows up to the geometry
// just committed. The output mark needs nothing here: its cut is read from
// its pin when the closing screen is read (outputStartSkipLocked).
//
// While the alternate screen holds the pane the primary's rows were re-laid
// out too, but no pin on them can be located (RowTrack.ActiveRow answers
// ErrUnsupported), so the repair is OWED rather than skipped: it runs the
// first time rows are drained with the primary back in front
// (settleOwedReflowLocked).
func (s *Session) reflowBoundaryLocked() {
	if scr, err := s.emulator.Screen(); err != nil || scr != emulator.ScreenPrimary {
		s.reflowOwed = true
		return
	}
	s.reflowOwed = false
	s.pendingScreen = s.reflowWindowLocked(s.pendingScreen)
	// A capture holding its sighting's window keeps the window it replaced,
	// to put back if nobody authenticates the fence; that one names the same
	// re-laid rows and must describe them as they are when it is put back.
	if c := s.pendingCapture; c != nil && c.Holding {
		c.Prior = s.reflowWindowLocked(c.Prior)
	}
}

// settleOwedReflowLocked runs a repair a commit owed while the alternate
// screen was in front, once the primary is back. The feed that brought the
// primary back may already have scrolled the window's rows away; what that
// feed reports after such a commit is nocx-2v80t.6's to settle.
func (s *Session) settleOwedReflowLocked() {
	if s.reflowOwed {
		s.reflowBoundaryLocked()
	}
}

// reflowWindowLocked rebuilds a window from where its pins now are. Each
// surviving pin names one physical row, but a narrower grid splits one row
// into several and a wider one joins several into one, so the window is
// rebuilt by LOGICAL line: every row the pin's line now occupies, walking up
// through continuations and down through wraps, read afresh and pinned
// afresh. Rows a pin names more than once (a widening joined them) are one
// entry.
//
// An entry that is alive but no longer on the active screen stays as it was,
// ahead of the rest: the commit pushed it into the history, where the only
// question left about it is whether it departs. A pinless or dead entry is
// left for the next purge.
func (s *Session) reflowWindowLocked(window []pendingBoundaryRow) []pendingBoundaryRow {
	if len(window) == 0 {
		return window
	}
	var kept []pendingBoundaryRow
	onScreen := map[int]bool{}
	cursorLine := -1
	for _, p := range window {
		if !p.alive() {
			kept = append(kept, p)
			continue
		}
		y, err := p.Track.ActiveRow()
		if err != nil {
			kept = append(kept, p)
			continue
		}
		first, last := s.logicalLineLocked(y)
		for r := first; r <= last; r++ {
			onScreen[r] = true
		}
		if p.Cursor {
			cursorLine = last
		}
		p.Track.Release()
	}
	rows := make([]int, 0, len(onScreen))
	for y := range onScreen {
		rows = append(rows, y)
	}
	sort.Ints(rows)
	for _, y := range rows {
		row, err := s.emulator.Row(y)
		if err != nil {
			continue
		}
		track, err := s.emulator.TrackRow(y)
		if err != nil {
			track = nil
		}
		kept = append(kept, pendingBoundaryRow{Row: cloneObservationRows([]emulator.Row{row})[0], Track: track, Cursor: y == cursorLine})
	}
	return kept
}

// logicalLineLocked is the span of active rows the soft-wrapped line through
// row y occupies: up while a row continues the one above it, down while a row
// wraps into the one below. A read past either edge fails and ends the walk.
func (s *Session) logicalLineLocked(y int) (first, last int) {
	first, last = y, y
	for first > 0 {
		row, err := s.emulator.Row(first)
		if err != nil || !row.Continuation {
			break
		}
		first--
	}
	for {
		row, err := s.emulator.Row(last)
		if err != nil || !row.Wrap {
			break
		}
		last++
	}
	return first, last
}
