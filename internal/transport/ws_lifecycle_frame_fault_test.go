package transport

// A FRAME THE STORE DID NOT COMMIT IS A FRAME THE NEXT COORDINATOR APPLIES,
// ONCE (ADR-0077). The frame's projection — here the start fact's: the
// entry, its execution, the block's artifact — and the coordinator's cursor
// past it are one transaction. A fault after the frame's last row and before
// the cursor, which is where a coordinator killed mid-frame dies, leaves
// neither behind; the process restarts, the next coordinator resumes the
// stream at the stored cursor, and the frame lands exactly once.

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/lifecyclepub"
	"github.com/shady2k/nocx/internal/session"
)

var errFaultAtTheCursor = errors.New("injected: the process dies after the frame's last row")

// applyFrameThroughTheStore applies one frame the way the coordinator does:
// the kernel's ingest inside the store's own frame, the cursor at offset.
// faultAtCursor fails the frame after its last row and before the cursor.
func applyFrameThroughTheStore(t *testing.T, db content.ContentDB, sid string, pub *lifecyclepub.Publisher,
	tID lifecycle.TransportID, env lifecycle.Envelope, offset uint64, faultAtCursor bool,
) error {
	t.Helper()
	return db.Ledger().ApplyLifecycleFrame(context.Background(), sid, offset, func(ctx context.Context) error {
		if err := pub.Ingest(ctx, tID, env); err != nil {
			t.Fatalf("the kernel refused the %s: %v", env.Event.Kind, err)
		}
		if faultAtCursor {
			return errFaultAtTheCursor
		}
		return nil
	})
}

// storedCursor is the cursor the store hands the next process: read the way
// a restarted coordinator reads it, from the pending bindings at Open.
func storedCursor(t *testing.T, path, sid string) (content.ContentDB, uint64) {
	t.Helper()
	db := newLedgerStoreAt(t, path)
	pending, err := db.Reconcile().Pending(context.Background())
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	for _, p := range pending {
		if p.SessionID == sid && p.LifecycleApplied != nil {
			return db, *p.LifecycleApplied
		}
	}
	t.Fatalf("the binding for %s carries no cursor", sid)
	return db, 0
}

func TestAFrameFailedAtTheCursorIsAppliedOnceByTheNextCoordinator(t *testing.T) {
	path := filepath.Join(t.TempDir(), "content.db")
	first := newLedgerStoreAt(t, path)
	e, pub, lane, h, sid, _ := newLifecycleLedgerEnvWithStore(t, first)
	zero := uint64(0)
	if err := first.Ledger().CreateSession(context.Background(), content.Session{
		ID: sid, WorkspaceID: "ws-lifecycle", LifecycleApplied: &zero,
	}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	e.ws.AttachBlockRows(session.ID(sid))

	const promptEnd, startEnd = 100, 220
	r := repeatFrames{lane: lane, h: h}
	if err := applyFrameThroughTheStore(t, first, sid, pub, "T", r.prompt(2), promptEnd, false); err != nil {
		t.Fatalf("the prompt frame: %v", err)
	}
	start := r.start(3, 0, "make build")
	if err := applyFrameThroughTheStore(t, first, sid, pub, "T", start, startEnd, true); !errors.Is(err, content.ErrLifecycleFrameFailed) {
		t.Fatalf("the faulted start frame = %v, want ErrLifecycleFrameFailed", err)
	}
	if shape := ledgerShape(t, first); shape != "" {
		t.Fatalf("the faulted frame left rows behind: %s", shape)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("closing the first coordinator's store: %v", err)
	}

	// The restart: the next coordinator reads the cursor the store holds.
	second, cursor := storedCursor(t, path, sid)
	if cursor != promptEnd {
		t.Fatalf("the stored cursor is %d, want %d — the end of the last frame whose rows were stored", cursor, promptEnd)
	}
	fresh := newFreshCoordinator(t, second, sid, lane, h)
	if err := applyFrameThroughTheStore(t, second, sid, fresh.pub, "T2", start, startEnd, false); err != nil {
		t.Fatalf("the start frame, offered again from the cursor: %v", err)
	}
	assertOneOfEach(t, second)
	if shape := ledgerShape(t, second); shape == "" {
		t.Fatal("the frame applied again stored nothing")
	}
}
