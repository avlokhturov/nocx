package transport

// A batch a caller has just taken out of bs.pending to hand to
// flushPendingRows must count against the buffer bound from that exact
// instant, not from whenever flushPendingRows itself gets around to it
// (nocx-2v80t.3.51, review round 6, finding 7). Before this bead,
// flushPendingRows counted its own batch after re-acquiring the lock — so
// every real caller's own sequence was: extract under lock, UNLOCK, then
// call flushPendingRows, which locks again to count. In between, the batch
// belonged to neither bs.pending (already removed) nor flushingBytes (not
// yet set): a genuine gap, but one with no I/O in it — nothing a store fake's
// block/release gate can pause on, because by the time any store call is
// reachable the gap has already closed. TestFlushingBatchCountsAgainstTheBufferBound
// (nocx-2v80t.3.49) waits for the store call to start before checking the
// bound, which is exactly why it could never have caught this: it checks the
// middle of the interval, not its start.
//
// This file reaches the start of the interval directly, with the two
// orderings side by side: the pre-fix shape (extract, unlock, count later)
// and the fixed one (extract and count in the SAME lock hold, before
// unlocking) — both paused at the identical point, on a channel rather than
// a sleep, right where a caller hands the batch to flushPendingRows. Only
// the fixed ordering may answer that a full-budget delivery overflows there.

import (
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/emulator"
	"github.com/shady2k/nocx/internal/session"
)

// handoffOrdering names the two sequences a caller can extract a batch and
// hand it to flushPendingRows with.
type handoffOrdering int

const (
	// handoffCountsAfterUnlock is every real call site's shape before this
	// bead: extract under lock, unlock, THEN let flushPendingRows count it
	// once it re-locks.
	handoffCountsAfterUnlock handoffOrdering = iota
	// handoffCountsAtExtraction is the fix: beginFlushLocked runs in the same
	// lock hold as the extraction, before the lock is ever released.
	handoffCountsAtExtraction
)

// runHandoff drives one caller's own half of the extract-then-flush handoff
// up to the point real code would call flushPendingRows, and pauses there —
// signaled on paused, released on proceed — so the test can inspect the
// bound at the exact moment described in round 6's finding 7, whichever
// ordering the caller used to reach it.
func runHandoff(bs *blockStream, sid session.ID, toFlush []pendingRows, ordering handoffOrdering, paused, proceed chan struct{}) {
	bs.mu.Lock()
	delete(bs.pending, sid)
	if ordering == handoffCountsAtExtraction {
		bs.beginFlushLocked(sid, toFlush)
	}
	bs.flushing[sid] = true
	bs.mu.Unlock()
	close(paused)
	<-proceed
	if ordering == handoffCountsAfterUnlock {
		// flushPendingRows itself used to do exactly this, after re-locking —
		// the pre-fix shape, reproduced here since old code has no
		// beginFlushLocked to call at all.
		bs.mu.Lock()
		if bs.flushingBytes == nil {
			bs.flushingBytes = make(map[session.ID]int64)
		}
		bs.flushingBytes[sid] = pendingRowsBytes(toFlush)
		bs.mu.Unlock()
	}
}

func testHandoffOrdering(t *testing.T, ordering handoffOrdering, wantOverflowAtPause bool) {
	t.Helper()
	db := newLedgerStore(t)
	e, pub, lane, h, sid, _ := newLifecycleLedgerEnvWithStore(t, db)
	e.ws.AttachBlockRows(session.ID(sid))

	rowBytes := heldRowsBytes([]emulator.Row{aStreamRow("x")})
	bs := e.ws.blockStream
	bs.mu.Lock()
	// Exactly the one row's own cost: a batch already counted for it leaves
	// no room at all for a further row, so the fixed ordering must overflow
	// one and the pre-fix ordering, having missed the count, must not.
	bs.budgets[session.ID(sid)] = rowBytes
	bs.mu.Unlock()

	_ = startsACommand(t, e, pub, lane, h, 2, "printf rows")
	toFlush := []pendingRows{{from: 0, rows: []emulator.Row{aStreamRow("x")}}}
	bs.mu.Lock()
	bs.pending[session.ID(sid)] = toFlush
	bs.mu.Unlock()

	paused := make(chan struct{})
	proceed := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		runHandoff(bs, session.ID(sid), toFlush, ordering, paused, proceed)
	}()

	select {
	case <-paused:
	case <-time.After(5 * time.Second):
		t.Fatal("the handoff goroutine never reached its rendezvous")
	}

	// Right here: bs.pending no longer holds the batch (removed above, under
	// the goroutine's own lock) — a second, full-budget row is exactly what
	// round 6's finding 7 describes arriving in this window.
	bs.mu.Lock()
	held := bs.heldBytesLocked(session.ID(sid))
	overflowsNow := held+rowBytes > bs.budgets[session.ID(sid)]
	bs.mu.Unlock()
	if overflowsNow != wantOverflowAtPause {
		t.Fatalf("held=%d, a further row would overflow=%v, want %v — the batch must count from the instant it leaves bs.pending, not from whenever flushPendingRows gets around to it",
			held, overflowsNow, wantOverflowAtPause)
	}

	close(proceed)
	<-done
}

// TestTheFixedHandoffCountsBeforeUnlocking is nocx-2v80t.3.51's part 7: with
// beginFlushLocked run in the SAME lock hold as the extraction — every real
// call site's shape now — a row arriving in the handoff window still
// overflows, because the batch was never in neither place at once.
func TestTheFixedHandoffCountsBeforeUnlocking(t *testing.T) {
	testHandoffOrdering(t, handoffCountsAtExtraction, true)
}

// Paired: the ordinary path with nothing racing the handoff still counts and
// releases the budget correctly once the batch lands — TestFlushingBatchCountsAgainstTheBufferBound
// and TestFlushingBatchReleasesTheBudgetOnceItLands already cover that; this
// pairing is the other half of THIS test's own claim — that the pre-fix
// ordering (count only after flushPendingRows re-locks) really did leave the
// window finding 7 named. Kept as a permanent regression marker: it must
// fail if this ordering is ever restored anywhere.
func TestThePreFixHandoffMissedTheWindow(t *testing.T) {
	testHandoffOrdering(t, handoffCountsAfterUnlock, false)
}
