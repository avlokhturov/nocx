package transport

// ADR-0076: the coordinator going away changes no block; only what the
// helper reports does.

import (
	"encoding/json"
	"testing"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/emulator"
	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/session"
)

// ADR-0076: the coordinator going away changes no block. DetachBlockRows
// forgets the streaming attachment and nothing else: the open block, its
// cursor, and its open ledger entry survive in the store, the re-attached
// stream continues them by absolute departed-row index, and the block ends
// only when the helper reports its end.
func TestDetachBlockRows_ACoordinatorDetachChangesNoBlock(t *testing.T) {
	e, pub, lane, h, sid, db := newLifecycleLedgerEnv(t, true)
	e.ws.AttachBlockRows(session.ID(sid))

	attempt := startsACommand(t, e, pub, lane, h, 2, "make restart")
	if written, confirm := e.ws.BlockRowsArrived(session.ID(sid), 0, 0, []emulator.Row{aStreamRow("kept-0"), aStreamRow("kept-1")}, ""); !confirm || written != 2 {
		t.Fatalf("first ack = (%d, %v), want rows 0 and 1 stored", written, confirm)
	}

	e.ws.DetachBlockRows(session.ID(sid))

	// The artifact is still open, its cursor still at 2: the detach changed
	// nothing in the store.
	art := blockArtifact(t, db, attempt)
	if art.State != content.ArtifactOpen {
		t.Fatalf("artifact state = %q after the coordinator detach, want open", art.State)
	}
	var payload struct {
		NextRow uint64 `json:"nextRow"`
	}
	if err := json.Unmarshal([]byte(art.Payload), &payload); err != nil {
		t.Fatalf("decode the payload: %v (raw %s)", err, art.Payload)
	}
	if payload.NextRow != 2 {
		t.Fatalf("cursor = %d after the coordinator detach, want 2", payload.NextRow)
	}

	// The stream re-attaches (the coordinator came back). The re-adopt's
	// attempt fact re-opens the attempt, and performOpen resumes the open
	// artifact at its stored cursor — that is what lets the continued rows
	// append rather than drop.
	e.ws.AttachBlockRows(session.ID(sid))
	e.ws.blockStream.openAttemptFor(e.ws, session.ID(sid), attempt)
	if written, confirm := e.ws.BlockRowsArrived(session.ID(sid), 2, 0, []emulator.Row{aStreamRow("kept-2"), aStreamRow("kept-3")}, ""); !confirm || written != 4 {
		t.Fatalf("continued ack = (%d, %v), want rows 2 and 3 appended to the open block", written, confirm)
	}

	// The helper reports the interval's end: only now does the block seal,
	// with every row it was given across the restart.
	fence := lifecycleFence(0x37)
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 3, lifecycleCompleteEvt(lifecycle.AttemptID(attempt), 0, fence)))
	e.ws.BlockIntervalEnded(session.ID(sid), fence, 4, nil, false)

	kept := streamRows(t, db, attempt)
	if len(kept) != 4 {
		t.Fatalf("the sealed block holds %d rows, want all four across the restart", len(kept))
	}
	for i, want := range []string{"kept-0", "kept-1", "kept-2", "kept-3"} {
		if kept[i].Text != want {
			t.Fatalf("row %d = %q, want %q", i, kept[i].Text, want)
		}
	}
}

// The paired half: when the HELPER reports the session's end, the open
// block settles (ADR-0074 decision 3 as amended by ADR-0076) — sealed,
// said closed, and inert to later rows.
func TestHelperSessionEnded_SealsTheOpenBlock(t *testing.T) {
	e, pub, lane, h, sid, db := newLifecycleLedgerEnv(t, true)
	e.ws.AttachBlockRows(session.ID(sid))

	attempt := startsACommand(t, e, pub, lane, h, 2, "make exit")
	if _, confirm := e.ws.BlockRowsArrived(session.ID(sid), 0, 0, []emulator.Row{aStreamRow("partial")}, ""); !confirm {
		t.Fatal("the streamed row was not confirmed")
	}

	e.ws.HelperSessionEnded(session.ID(sid))

	art := blockArtifact(t, db, attempt)
	if art.State != content.ArtifactSealed {
		t.Fatalf("artifact state = %q after the helper reported the session's end, want sealed", art.State)
	}
	if _, confirm := e.ws.BlockRowsArrived(session.ID(sid), 5, 0, []emulator.Row{aStreamRow("late")}, ""); confirm {
		t.Fatal("a session the helper reported ended still answered rows")
	}
}
