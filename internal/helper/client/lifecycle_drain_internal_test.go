package client

// The lifecycle drain's client half (nocx-zg3k3.5.11 Round 4): the one-shot
// hold a re-adopted session's end waits on. Three release conditions and one
// one-shot rule, each pinned:
//
//   - the cursor reaches the target — the drain closes as the bridge READS
//     the frames, not when the helper sends them (the cursor is the ingest
//     position, and the ingest is the fact the transport's exit waits for);
//   - the target is already reached — the drain is born closed (a window the
//     attach answer already covers owes no replay);
//   - the attachment ends — finish closes an armed hold, so a stream that is
//     over can never owe a window;
//   - a second arm returns the first hold — the drain is per attachment.
//
// The ack is driven against a client already marked lost: Call answers
// ErrLost without a conn, which is the same non-fatal warn the live wire
// produces for a refused ack.

import (
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/shady2k/nocx/internal/helper/proto"
)

func drainFixture() (*Client, *AttachedSession) {
	c := &Client{
		log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		attachments: make(map[[16]byte]*AttachedSession),
		lost:        true, lostErr: errors.New("test transport lost"),
	}
	a := &AttachedSession{
		client: c, session: [16]byte{1}, subscriber: [16]byte{2},
		lifecycleData: newStream(), done: make(chan struct{}),
	}
	c.attachments[a.subscriber] = a
	return c, a
}

func drainSettled(drained <-chan struct{}) bool {
	select {
	case <-drained:
		return true
	default:
		return false
	}
}

func TestALifecycleDrainClosesWhenTheCursorReachesItsTarget(t *testing.T) {
	_, a := drainFixture()
	drained := a.LifecycleDrained(proto.StreamOffset(8))
	if drainSettled(drained) {
		t.Fatal("the drain closed before any frame was ingested")
	}

	a.deliverLifecycle([]byte("12345678"))
	n, err := a.Lifecycle().Read(make([]byte, 16))
	if err != nil || n != 8 {
		t.Fatalf("the frame read = %d, %v, want 8, nil", n, err)
	}
	if !drainSettled(drained) {
		t.Fatal("the drain is still open after the cursor reached the target")
	}
}

func TestAnAlreadyReachedTargetClosesTheDrainAtOnce(t *testing.T) {
	_, a := drainFixture()
	a.mu.Lock()
	a.lifecycleOffset = 12
	a.mu.Unlock()
	if drained := a.LifecycleDrained(proto.StreamOffset(12)); !drainSettled(drained) {
		t.Fatal("a drain armed at a target the cursor already reached is not closed")
	}
}

func TestAnEndedAttachmentClosesItsDrain(t *testing.T) {
	_, a := drainFixture()
	drained := a.LifecycleDrained(proto.StreamOffset(8))
	a.finish()
	if !drainSettled(drained) {
		t.Fatal("the drain is still open after the attachment ended")
	}
}

func TestASecondDrainArmReturnsTheFirstHold(t *testing.T) {
	_, a := drainFixture()
	first := a.LifecycleDrained(proto.StreamOffset(8))
	if second := a.LifecycleDrained(proto.StreamOffset(100)); second != first {
		t.Fatal("a second arm minted a second hold; the drain is per attachment")
	}
}
