package transport

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/lifecyclepub"
	"github.com/shady2k/nocx/internal/session"
	"github.com/shady2k/nocx/internal/ssh"
)

// The session integration axis (nocx-dvql). The contract tests prove the
// shape and the handshake-timeout path off the real socket; these prove the
// transitions the product's badge and card depend on, and the paths where
// the honest answer is to say nothing at all.

// readIntegration reads the next session.integrationChanged for a session.
func readIntegration(t *testing.T, conn *websocket.Conn, sid string) integrationChangedParams {
	t.Helper()
	for {
		raw := readNotification(t, conn, "session.integrationChanged", wantWithin)
		var p integrationChangedParams
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatalf("decode session.integrationChanged: %v\nraw: %s", err, raw)
		}
		if p.SessionID == sid {
			return p
		}
	}
}

// integrationEnv boots a server with a lifecycle publisher, opens a session,
// registers a lane and enters the session into the axis as `starting` — the
// state every attempted integration begins in.
type integrationEnv struct {
	*lifecycleTestEnv
	pub  *lifecyclepub.Publisher
	sid  string
	lane lifecycle.LaneID
	h    lifecycle.DomainHandle
}

func newIntegrationEnv(t *testing.T) *integrationEnv {
	t.Helper()
	kernel := lifecycle.New(lifecycle.Options{})
	pub := lifecyclepub.New(kernel)
	e := newLifecycleTestEnv(t, WithLifecyclePublisher(pub))
	pub.SetEmitter(e.ws)
	sid := e.openSession(t, 1)
	const lane = lifecycle.LaneID("lane-1")
	e.ws.RegisterLifecycleLane(lane, session.ID(sid))
	if err := pub.BindTransport("T", noopPort{}); err != nil {
		t.Fatal(err)
	}
	h, err := pub.RequestDomain(lane, nil, "T")
	if err != nil {
		t.Fatalf("RequestDomain: %v", err)
	}
	e.ws.RegisterIntegration(session.ID(sid), "/bin/bash", IntegrationStarting, ssh.ReasonNone)
	e.ws.emitIntegration(session.ID(sid))
	if first := readIntegration(t, e.conn, sid); first.Status != IntegrationStarting {
		t.Fatalf("first status = %q, want starting", first.Status)
	}
	return &integrationEnv{lifecycleTestEnv: e, pub: pub, sid: sid, lane: lane, h: h}
}

// establish drives the handshake to a live domain, the way a shell would,
// and returns the integration status the hello produced.
//
// The status frame is read BEFORE the establishment acknowledgement, because
// that is the order the server writes them: the axis is updated from the
// published fact and emitted first, and the lifecycle.changed fact follows on
// the same socket. Reading them the other way round makes the establishment
// helper swallow the status frame.
func (e *integrationEnv) establish(t *testing.T) integrationChangedParams {
	t.Helper()
	mustLifecycleIngest(t, e.pub, "T", lifecycleEnv(e.lane, e.h, 1, lifecycleHelloEvt()))
	got := readIntegration(t, e.conn, e.sid)
	ackEstablishmentFrom(t, e.pub, e.lane, e.h, e.conn)
	return got
}

// A live domain is the kernel's own word that this session integrated, and
// the axis follows it rather than re-deriving it.
func TestIntegration_LiveDomainReportsIntegrated(t *testing.T) {
	e := newIntegrationEnv(t)
	got := e.establish(t)
	if got.Status != IntegrationIntegrated {
		t.Errorf("status = %q, want integrated", got.Status)
	}
	if got.Reason != "" {
		t.Errorf("reason = %q, want none: an integrated session has nothing to explain", got.Reason)
	}
	if got.Shell != "/bin/bash" {
		t.Errorf("shell = %q, want the launch's own answer, unrevised", got.Shell)
	}
}

// A channel that dies AFTER the session integrated is `lost`, not
// `conventional`. The same transport loss means different things either side
// of establishment, and only the session knows which side it is on: a user
// whose blocks stopped appearing mid-session is not in the same situation as
// one whose shell never answered.
func TestIntegration_LossAfterEstablishmentIsLost(t *testing.T) {
	e := newIntegrationEnv(t)
	if got := e.establish(t); got.Status != IntegrationIntegrated {
		t.Fatalf("status = %q, want integrated before the loss", got.Status)
	}

	e.ws.NoteIntegrationLoss(e.lane, "end-of-stream")
	got := readIntegration(t, e.conn, e.sid)
	if got.Status != IntegrationLost {
		t.Errorf("status = %q, want lost", got.Status)
	}
	if got.Reason != string(ssh.ReasonChannelLost) {
		t.Errorf("reason = %q, want channel-lost", got.Reason)
	}
}

// A descriptor that ends before the shell ever proved itself is `unknown`,
// not `handshake-timeout`. The backend genuinely cannot say which, and
// claiming a bound expired when it did not is the invented confidence this
// surface exists to avoid — `unknown` is a real, visible answer.
func TestIntegration_LossBeforeEstablishmentWithoutTimeoutIsUnknown(t *testing.T) {
	e := newIntegrationEnv(t)
	e.ws.NoteIntegrationLoss(e.lane, "end-of-stream")
	got := readIntegration(t, e.conn, e.sid)
	if got.Status != IntegrationConventional {
		t.Errorf("status = %q, want conventional", got.Status)
	}
	if got.Reason != string(ssh.ReasonUnknown) {
		t.Errorf("reason = %q, want unknown", got.Reason)
	}
}

// The session's own disposal is not a degrade. A tab closing must not paint
// itself broken on the way out — the badge would flash on every close and
// teach the user that the badge means nothing.
func TestIntegration_SessionDisposalSaysNothing(t *testing.T) {
	e := newIntegrationEnv(t)
	if got := e.establish(t); got.Status != IntegrationIntegrated {
		t.Fatalf("status = %q, want integrated", got.Status)
	}

	e.ws.NoteIntegrationLoss(e.lane, LossCauseClosed)
	if leaked := tryReadNotification(t, e.conn, "session.integrationChanged", 300*time.Millisecond); leaked != nil {
		t.Errorf("a closing session announced a degrade: %s", leaked)
	}
}

// A session that never asked for integration is never registered, and
// therefore never speaks. Absence is how "conventional by design" is
// expressed; a badge on a raw tab the user chose is noise.
func TestIntegration_UnregisteredSessionSaysNothing(t *testing.T) {
	e := newLifecycleTestEnv(t)
	sid := e.openSession(t, 1)
	e.ws.emitIntegration(session.ID(sid))
	if leaked := tryReadNotification(t, e.conn, "session.integrationChanged", 300*time.Millisecond); leaked != nil {
		t.Errorf("a session that requested no integration announced a status: %s", leaked)
	}
}

// The status is a state, not an event (AD-9). A frontend that reconnects
// after the handshake expired must learn it is in a conventional terminal —
// no further transition is ever coming to tell it, so the replay is the only
// thing that can.
func TestIntegration_ReattachReplaysTheCurrentStatus(t *testing.T) {
	e := newIntegrationEnv(t)
	e.ws.NoteIntegrationLoss(e.lane, LossCauseHelloTimeout)
	if got := readIntegration(t, e.conn, e.sid); got.Reason != string(ssh.ReasonHandshakeTimeout) {
		t.Fatalf("reason = %q, want handshake-timeout", got.Reason)
	}

	connB := connectWS(t, e.ws)
	defer func() { _ = connB.Close() }()
	resp := jsonrpcCallWithID(t, connB, "attach", map[string]any{"sessionId": e.sid, "offset": 0}, 2)
	var envelope struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(resp, &envelope); err != nil {
		t.Fatalf("attach: %v", err)
	}
	if envelope.Error != nil {
		t.Fatalf("attach: %+v", envelope.Error)
	}
	got := readIntegration(t, connB, e.sid)
	if got.Status != IntegrationConventional || got.Reason != string(ssh.ReasonHandshakeTimeout) {
		t.Errorf("replayed status = %+v, want conventional/handshake-timeout", got)
	}
}

// A loss for a lane nobody registered resolves to no session and is dropped,
// rather than reaching for a session id it does not have.
func TestIntegration_LossOnAnUnknownLaneIsDropped(t *testing.T) {
	e := newIntegrationEnv(t)
	e.ws.NoteIntegrationLoss(lifecycle.LaneID("lane-nobody"), LossCauseHelloTimeout)
	if leaked := tryReadNotification(t, e.conn, "session.integrationChanged", 300*time.Millisecond); leaked != nil {
		t.Errorf("an unregistered lane produced a status: %s", leaked)
	}
}
