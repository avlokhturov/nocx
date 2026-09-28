package transport

// The screen plane's publish seam.
//
// The reserved metadata msg-type is the seat the data plane held for exactly
// this: a screen frame is neither PTY bytes (it must never ride MsgTypeData,
// whose pump, ring and credit accounting are the byte stream's — AD-6) nor a
// control-plane call (it is not JSON-RPC, AD-1). It rides the binary framing
// every other plane rides — version, msg-type, session-id, payload — with
// the payload being one whole session.frame document at one revision, as the
// helper's carrier delivered it. The revision is inside the document, where
// the renderer's generated type reads it.
//
// Publishing is per session and goes to the session's CURRENT subscriber —
// the same single slot the PTY pump serves, because one client owns a
// session (D8) and the renderer half of the plane consumes exactly what that
// client sees.
//
// A full outbound queue drops the frame, deliberately. The class permits it
// — every frame is a full snapshot, so the next revision supersedes what was
// lost — and the subscriber is not silently abandoned: the outbound queue's
// own stall policy is what the renderer sees, and the next revision it can
// drain repaints the whole screen. What is refused is the PTY path's answer
// (wait for room), because waiting would put the screen plane's backpressure
// on the byte stream's pump.
//
// Nobody attached is nothing lost: a screen published to nobody has no
// consumer, and the first frame a new subscriber is owed is its baseline.
// The runtime's per-consumer baseline cannot deliver it: the runtime's
// consumer is the coordinator's one helper subscription, attached once, not
// each window. So installing a subscriber asks for the frame the runtime
// holds now (resendScreen, nocx-zg3k3.2.15), and it arrives here like any
// other revision.

import (
	"context"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/session"
)

// ScreenResender asks the process that holds a session's terminal to re-offer
// the frame its runtime last published (nocx-zg3k3.2.15). The frame is not the
// answer: it arrives through PublishScreenFrame, the seam every published
// frame takes, so it is ordered with every other revision rather than raced
// against them.
type ScreenResender interface {
	ResendScreen(ctx context.Context, sessionID string) error
}

// WithScreenResender wires the route a newly installed subscriber's baseline
// is asked for. Unwired, a subscriber sees the next revision the runtime
// publishes and nothing before it.
func WithScreenResender(r ScreenResender) WSServerOption {
	return func(ws *WSServer) { ws.screenResender = r }
}

// resendScreen asks for the frame a subscriber just installed on sid is owed.
//
// Called by the two installs, open and attach, after their ack and after
// setSubscriber, so the frame it causes resolves to THIS subscriber at
// publish time and never precedes the answer that told the renderer the
// session id (AD-7). It is the ONE thing that repaints an install: the
// resize an attach with a size causes also publishes, but that is a side
// effect of the geometry and a client with nothing to report never gets it.
//
// It runs on the handler, last, after the ack is sent and the pumps are
// started — not on a goroutine of its own, which would escape the control
// plane's scheduling contract (ADR-0026). The round trip it costs is bounded
// by the resender, which knows the route it takes, and delays no answer and
// no PTY byte. A failure is logged, not answered: the request has already
// been answered, and the next revision the runtime publishes repaints the
// window whole.
func (s *WSServer) resendScreen(ctx context.Context, sid session.ID) {
	if s.screenResender == nil {
		return
	}
	if err := s.screenResender.ResendScreen(ctx, string(sid)); err != nil {
		log.From(ctx).Warn("the screen a new subscriber is owed could not be asked for; it stays blank until the next revision",
			"session_id", string(sid), "error", err)
	}
}

// PublishScreenFrame puts one published screen frame on the data plane for
// the session's current subscriber. It answers whether the frame was queued:
// false means nobody was attached or the subscriber's queue refused it, and
// both are visible decisions rather than silent ones — the drop is logged
// here, and the next revision the runtime publishes repaints whole.
func (s *WSServer) PublishScreenFrame(sid session.ID, revision uint64, doc []byte) bool {
	rx := s.getRx(sid)
	if rx == nil {
		return false
	}
	wconn, _ := rx.getSubscriber()
	if wconn == nil {
		return false
	}
	sidBytes, err := session.IDToBytes(sid)
	if err != nil {
		s.log.Warn("screen frame dropped: session id does not fit the frame header",
			"session_id", string(sid), "revision", revision, "error", err)
		return false
	}
	f := Frame{
		Version:   FrameVersion,
		MsgType:   MsgTypeMetadata,
		SessionID: sidBytes,
		Payload:   doc,
	}
	if enqueueErr := wconn.out.TryEnqueue(websocket.BinaryMessage, f.Encode()); enqueueErr != nil {
		// The subscriber is behind and its stall policy is what it sees; the
		// next revision supersedes this one whole.
		s.log.Warn("screen frame dropped: the subscriber's outbound queue is full",
			"session_id", string(sid), "revision", revision, "error", enqueueErr)
		return false
	}
	return true
}
