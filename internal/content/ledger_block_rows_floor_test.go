package content_test

// Round 8 (nocx-zg3k3.5.3): the block's stored span is [FirstRow, NextRow).
// A command's first rows can depart before its open lands; its block's first
// delivery then starts above the session's origin, and the resend later
// re-offers the head. The store takes the head when it is CONTIGUOUS with
// the floor (it joins the stored span's beginning) and refuses anything
// else below it, as the discontinuity it always was.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/emulator"
)

func TestABlockTakesAContiguousDeliveryBelowItsFloor(t *testing.T) {
	ctx := context.Background()
	_, led := newLedger(t)
	entryID := recordOne(t, led, "head loses the race")
	artifact := "00000000-0000-7000-8000-00000000000f"
	if _, err := led.OpenBlockOutput(ctx, content.OpenBlockOutput{
		EntryID: entryID, ArtifactID: artifact,
	}); err != nil {
		t.Fatalf("OpenBlockOutput: %v", err)
	}
	// The block's first delivery began at absolute 6: the command's rows
	// R7 and R8 reached the store; R1..R6 departed before the block opened.
	if err := led.AppendBlockRows(ctx, content.AppendBlockRows{
		EntryID: entryID, ArtifactID: artifact, FromRow: 6,
		Rows: []emulator.Row{aTextRow("R7"), aTextRow("R8")},
	}); err != nil {
		t.Fatalf("the first delivery: %v", err)
	}
	// The resend re-offers the head: [2..6), contiguous with the floor.
	if err := led.AppendBlockRows(ctx, content.AppendBlockRows{
		EntryID: entryID, ArtifactID: artifact, FromRow: 2,
		Rows: []emulator.Row{aTextRow("R3"), aTextRow("R4"), aTextRow("R5"), aTextRow("R6")},
	}); err != nil {
		t.Fatalf("the contiguous head below the floor: %v", err)
	}
	// The stored span is [2..8): the head first, then the first delivery.
	lines := storedBlockRows(t, led, artifact)
	if len(lines) != 6 {
		t.Fatalf("the artifact holds %d rows, want the head and the first delivery's 6", len(lines))
	}
	if lines[0].From != 2 || !strings.Contains(lines[0].Text, "R3") {
		t.Fatalf("the artifact's first row is from=%d %q, want the prepended head's R3 at 2", lines[0].From, lines[0].Text)
	}
	if lines[len(lines)-1].From != 7 || !strings.Contains(lines[len(lines)-1].Text, "R8") {
		t.Fatalf("the artifact's last row is from=%d %q, want the first delivery's R8", lines[len(lines)-1].From, lines[len(lines)-1].Text)
	}
	// The re-bind read answers the new floor.
	entry, err := led.OpenBlockRowsForSession(ctx, "no-such-session")
	if err != nil {
		t.Fatalf("OpenBlockRowsForSession: %v", err)
	}
	_ = entry // an entry recorded without a session answers empty; the floor
	// rides the artifact payload the re-bind read decodes.
}

func TestABlockRefusesADiscontinuousDeliveryBelowItsFloor(t *testing.T) {
	ctx := context.Background()
	_, led := newLedger(t)
	entryID := recordOne(t, led, "head loses the race")
	artifact := "00000000-0000-7000-8000-0000000000f1"
	if _, err := led.OpenBlockOutput(ctx, content.OpenBlockOutput{
		EntryID: entryID, ArtifactID: artifact,
	}); err != nil {
		t.Fatalf("OpenBlockOutput: %v", err)
	}
	if err := led.AppendBlockRows(ctx, content.AppendBlockRows{
		EntryID: entryID, ArtifactID: artifact, FromRow: 6,
		Rows: []emulator.Row{aTextRow("R7"), aTextRow("R8")},
	}); err != nil {
		t.Fatalf("the first delivery: %v", err)
	}
	// [0..4) does not join the stored span's beginning (its end is 4, the
	// floor is 6): refused, and the artifact untouched.
	err := led.AppendBlockRows(ctx, content.AppendBlockRows{
		EntryID: entryID, ArtifactID: artifact, FromRow: 0,
		Rows: []emulator.Row{aTextRow("R1"), aTextRow("R2"), aTextRow("R3"), aTextRow("R4")},
	})
	if !errors.Is(err, content.ErrBlockRowsDiscontinuous) {
		t.Fatalf("a non-contiguous delivery below the floor: err %v, want ErrBlockRowsDiscontinuous", err)
	}
	if lines := storedBlockRows(t, led, artifact); len(lines) != 2 {
		t.Fatalf("the refused delivery changed the artifact: %d rows, want the original 2", len(lines))
	}
}
