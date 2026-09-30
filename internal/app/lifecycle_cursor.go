package app

// THE COORDINATOR'S OWN LIFECYCLE CURSOR (ADR-0077).
//
// A coordinator that goes away and a coordinator that comes back share no
// memory, only the store. The PTY leg already resumes from what the store
// holds — the recording's length — and the owner's decision of 2026-09-30
// puts the lifecycle leg on the same footing: the re-adopt asks the helper
// for its lifecycle stream from the offset one past the last frame whose
// effect THIS machine stored. Nothing before that offset is offered again
// (ADR-0024's reason for resuming at the head holds: those frames carry a
// capability the adopted domain still honours), and nothing after it is
// skipped (ADR-0076 decision 4: an end the helper saw while nobody was
// attached settles its block on return).
//
// Two facts meet here and nowhere else. The adapter knows where in ITS
// carrier each frame ends and when the kernel has finished applying it
// (lifecyclechannel.WithFrameApplied). The bridge knows which stretch of the
// helper's stream it handed that carrier — every byte it relays arrives at
// the adapter's end of an in-memory pipe verbatim and in order, and the
// attachment's own ingest cursor says where each stretch ends in the
// helper's stream. So the bridge records each relayed stretch BEFORE it
// writes it, the adapter reports each applied frame's end, and this type
// translates one into the other and stores the result — synchronously, on
// the adapter's pump, after the frame's effect and before the next frame is
// read. A cursor stored that way never covers a frame whose effect is not
// stored, which is the half of "atomic with its effect" that loses nothing.

import (
	"context"
	"sync"

	"github.com/shady2k/nocx/internal/helper/proto"
	"github.com/shady2k/nocx/internal/log"
)

// lifecycleCursorStore is where the cursor is kept: the session's binding
// row (content.LedgerRepository satisfies it). Nil keeps nothing — a
// coordinator with no store has no record for the next one to resume from.
type lifecycleCursorStore interface {
	RecordLifecycleApplied(ctx context.Context, sessionID string, offset uint64) error
}

// lifecycleOffsets is the attachment's ingest cursor: the helper stream
// offset one past the last lifecycle byte its reader handed over.
type lifecycleOffsets interface {
	LifecycleIngested() proto.StreamOffset
}

// relayedSpan is one stretch the bridge handed the adapter's carrier: it ends
// at pipeEnd in the carrier and at streamEnd in the helper's stream.
type relayedSpan struct {
	pipeEnd   uint64
	streamEnd uint64
}

// cursorWait is one waiter for the applied cursor to reach target.
type cursorWait struct {
	target uint64
	ch     chan struct{}
}

// lifecycleCursor is one lifecycle leg's applied cursor. Built before the
// adapter (its report is an adapter option), bound to its session once the
// helper has named it, and fed by the bridge.
type lifecycleCursor struct {
	ctx   context.Context
	store lifecycleCursorStore

	mu      sync.Mutex
	sid     string
	spans   []relayedSpan
	piped   uint64
	applied uint64
	waits   []cursorWait
	ended   bool
}

// newLifecycleCursor builds a cursor whose writes run under ctx's values and
// never under its cancellation: the leg outlives the request that opened it.
func newLifecycleCursor(ctx context.Context, store lifecycleCursorStore) *lifecycleCursor {
	return &lifecycleCursor{ctx: context.WithoutCancel(ctx), store: store}
}

// bind names the session the cursor is stored under and the helper stream
// offset the attachment starts at — where "nothing applied yet" stands.
func (c *lifecycleCursor) bind(sid string, from proto.StreamOffset) {
	c.mu.Lock()
	c.sid = sid
	c.applied = uint64(from)
	c.releaseLocked()
	c.mu.Unlock()
}

// relayed records one stretch the bridge is about to hand the adapter: n
// bytes ending at streamEnd in the helper's stream. It must run BEFORE the
// write: the carrier is an in-memory pipe, so the adapter can read, apply and
// report a frame from these bytes before the write even returns.
func (c *lifecycleCursor) relayed(n int, streamEnd proto.StreamOffset) {
	if n <= 0 {
		return
	}
	c.mu.Lock()
	c.piped += uint64(n)
	c.spans = append(c.spans, relayedSpan{pipeEnd: c.piped, streamEnd: uint64(streamEnd)})
	c.mu.Unlock()
}

// frameApplied is the adapter's report: the frame ending at consumed bytes
// into the carrier has been applied. The helper stream offset it ends at is
// stored before this returns.
func (c *lifecycleCursor) frameApplied(consumed uint64) {
	c.mu.Lock()
	offset, ok := c.streamOffsetLocked(consumed)
	if !ok || offset <= c.applied {
		c.mu.Unlock()
		if !ok {
			log.From(c.ctx).Warn("lifecycle cursor: an applied frame ends outside every relayed stretch; the cursor stays where it was",
				"session", c.sid, "consumed", consumed)
		}
		return
	}
	c.applied = offset
	sid, store := c.sid, c.store
	c.releaseLocked()
	c.mu.Unlock()
	if store == nil || sid == "" {
		return
	}
	if err := store.RecordLifecycleApplied(c.ctx, sid, offset); err != nil {
		// The next coordinator then resumes from an older cursor and is
		// offered frames this one applied — the direction ADR-0024 guards,
		// so it is said out loud rather than left in a counter.
		log.From(c.ctx).Warn("lifecycle cursor: the applied offset could not be stored",
			"session", sid, "offset", offset, "error", err)
	}
}

// streamOffsetLocked translates a carrier position into the helper stream
// offset, and forgets every stretch wholly behind it.
func (c *lifecycleCursor) streamOffsetLocked(consumed uint64) (uint64, bool) {
	for i, span := range c.spans {
		if span.pipeEnd < consumed {
			continue
		}
		c.spans = c.spans[i:]
		behind := span.pipeEnd - consumed
		if behind > span.streamEnd {
			return 0, false
		}
		return span.streamEnd - behind, true
	}
	return 0, false
}

// reached answers a channel that closes once the applied cursor reaches
// target — every frame the helper's window held up to there is applied — or
// the leg has ended and will apply nothing more.
func (c *lifecycleCursor) reached(target proto.StreamOffset) <-chan struct{} {
	ch := make(chan struct{})
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ended || c.applied >= uint64(target) {
		close(ch)
		return ch
	}
	c.waits = append(c.waits, cursorWait{target: uint64(target), ch: ch})
	return ch
}

// end says the adapter's pump has stopped: nothing more will be applied, so
// nobody waits for it.
func (c *lifecycleCursor) end() {
	c.mu.Lock()
	c.ended = true
	c.releaseLocked()
	c.mu.Unlock()
}

func (c *lifecycleCursor) releaseLocked() {
	kept := c.waits[:0]
	for _, w := range c.waits {
		if c.ended || c.applied >= w.target {
			close(w.ch)
			continue
		}
		kept = append(kept, w)
	}
	c.waits = kept
}
