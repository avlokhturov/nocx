package transport

// session.liveness on the wire (nocx-iarf9). These tests drive the real
// pipeline — a real registry, a real observation, the real socket — and assert
// what the renderer receives, including the two things it must NOT receive.

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/pty"
	"github.com/shady2k/nocx/internal/session"
)

// livenessWire is the notification as the renderer decodes it.
type livenessWire struct {
	SessionID     string `json:"sessionId"`
	InstanceID    string `json:"instanceId"`
	SessionEpoch  uint64 `json:"sessionEpoch"`
	Liveness      string `json:"liveness"`
	LivenessEpoch uint64 `json:"livenessEpoch"`
	ObservedAt    string `json:"observedAt"`
}

// newLivenessServer builds a server over a real registry whose channel the
// test controls, with the registry's liveness watcher wired exactly as the
// composition root wires it.
func newLivenessServer(t *testing.T, fake *exitFakePTY) (*WSServer, *session.Reg) {
	t.Helper()
	reg := session.New(log.NewSlogAdapter(nil), &exitFakePTYFactory{fake: fake})
	ws := NewWSServer(log.NewSlogAdapter(nil), reg)
	reg.SetLivenessObserver(ws.PublishLiveness)
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	return ws, reg
}

func openLivenessSession(t *testing.T, ws *WSServer) (session.Ref, *websocket.Conn) {
	t.Helper()
	sid, conn := openExitSession(t, ws)
	sess, err := ws.registry.Get(session.ID(sid))
	if err != nil {
		t.Fatalf("registry.Get: %v", err)
	}
	return session.Ref{ID: sess.ID(), Identity: sess.Identity()}, conn
}

// observeUnknown makes the observation the keepalive prober makes when a host
// stops answering, at an epoch newer than the record's.
func observeUnknown(t *testing.T, reg *session.Reg, ws *WSServer, ref session.Ref) {
	t.Helper()
	sess, err := ws.registry.Get(ref.ID)
	if err != nil {
		t.Fatalf("registry.Get: %v", err)
	}
	obs := session.Observation{
		Liveness:   session.LivenessUnknown,
		Epoch:      sess.Liveness().Epoch + 1,
		ObservedAt: time.Now(),
	}
	if !reg.Observe(ref, obs) {
		t.Fatal("the observation was refused")
	}
}

// A host that stops answering reaches the renderer as unknown, carrying the
// incarnation it is about and the epoch that orders it — and the tab is still
// open, because nothing ended.
func TestLiveness_UnknownReachesTheRendererOverTheWire(t *testing.T) {
	schema := loadSchema(t, "session.liveness.schema.json")
	fake := newExitFakePTY()
	ws, reg := newLivenessServer(t, fake)
	ref, conn := openLivenessSession(t, ws)

	observeUnknown(t, reg, ws, ref)

	raw := readNotification(t, conn, "session.liveness", wantWithin)
	validateJSON(t, schema, raw, "session.liveness params (real socket)")

	var got livenessWire
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("session.liveness params: unmarshal: %v", err)
	}
	if got.Liveness != string(session.LivenessUnknown) {
		t.Errorf("liveness = %q, want %q", got.Liveness, session.LivenessUnknown)
	}
	if got.SessionID != string(ref.ID) {
		t.Errorf("sessionId = %q, want %q", got.SessionID, ref.ID)
	}
	if got.InstanceID != string(ref.Identity.InstanceID) || got.SessionEpoch != ref.Identity.Epoch {
		t.Errorf("incarnation = %s/%d, want %s/%d",
			got.InstanceID, got.SessionEpoch, ref.Identity.InstanceID, ref.Identity.Epoch)
	}
	if got.LivenessEpoch == 0 {
		t.Error("livenessEpoch = 0: a receiver cannot refuse a late report without one")
	}
	if _, err := time.Parse(time.RFC3339, got.ObservedAt); err != nil {
		t.Errorf("observedAt = %q is not RFC3339: %v", got.ObservedAt, err)
	}
}

// And back to alive: the state is revisable in both directions, which is what
// keeps `unknown` from being a one-way door into a tab nobody can trust again.
func TestLiveness_TheReturnToAliveAlsoCrossesTheWire(t *testing.T) {
	fake := newExitFakePTY()
	ws, reg := newLivenessServer(t, fake)
	ref, conn := openLivenessSession(t, ws)

	observeUnknown(t, reg, ws, ref)
	first := readNotification(t, conn, "session.liveness", wantWithin)
	var unknown livenessWire
	if err := json.Unmarshal(first, &unknown); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	sess, _ := ws.registry.Get(ref.ID)
	if !reg.Observe(ref, session.Observation{
		Liveness:   session.LivenessAlive,
		Epoch:      sess.Liveness().Epoch + 1,
		ObservedAt: time.Now(),
	}) {
		t.Fatal("the recovery observation was refused")
	}

	raw := readNotification(t, conn, "session.liveness", wantWithin)
	var got livenessWire
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Liveness != string(session.LivenessAlive) {
		t.Errorf("liveness = %q, want %q", got.Liveness, session.LivenessAlive)
	}
	if got.LivenessEpoch <= unknown.LivenessEpoch {
		t.Errorf("livenessEpoch = %d, want greater than the unknown report's %d",
			got.LivenessEpoch, unknown.LivenessEpoch)
	}
}

// The session that ended says so through `exit`, and this axis stays silent.
// Two messages for one fact is the defect the open ack's shellIntegrationReason
// was removed for; here the terminal value is simply never published, and the
// renderer learns the end from the notification that already carries a cause.
func TestLiveness_ATerminalSessionIsTheExitNotificationsNews(t *testing.T) {
	fake := newExitFakePTY()
	ws, reg := newLivenessServer(t, fake)
	ref, conn := openLivenessSession(t, ws)

	fake.recordWait(errors.New("ssh: connection lost"))
	got := awaitExit(t, conn)
	if got.Cause != string(session.ExitInterrupted) {
		t.Fatalf("cause = %q, want %q", got.Cause, session.ExitInterrupted)
	}

	// The record is terminal now, and an observation about it is refused —
	// so nothing can be published either.
	if reg.Observe(ref, session.Observation{
		Liveness:   session.LivenessAlive,
		Epoch:      1 << 20,
		ObservedAt: time.Now(),
	}) {
		t.Error("an observation was applied to a session that had ended")
	}
	assertNoNotification(t, conn, "session.liveness")
}

// PublishLiveness refuses a ref naming another incarnation of the same id: a
// late report must never be applied to the session that merely inherited the
// id. Driven at the publisher, because the registry's own refusal would
// otherwise be the only thing under test.
func TestPublishLiveness_RefusesAnotherIncarnation(t *testing.T) {
	fake := newExitFakePTY()
	ws, _ := newLivenessServer(t, fake)
	ref, conn := openLivenessSession(t, ws)

	stale := ref
	stale.Identity.Epoch++
	ws.PublishLiveness(stale)
	assertNoNotification(t, conn, "session.liveness")

	foreign := ref
	foreign.Identity.InstanceID = session.InstanceID("ffffffffffffffffffffffffffffffff")
	ws.PublishLiveness(foreign)
	assertNoNotification(t, conn, "session.liveness")

	// A ref naming no session at all is the same silence, not a panic.
	ws.PublishLiveness(session.Ref{ID: session.NewID(), Identity: ref.Identity})
	assertNoNotification(t, conn, "session.liveness")
}

// assertNoNotification fails if the named notification arrives before the
// server answers a round trip on the same connection. The round trip is the
// ordering fact this waits on — not a duration: a notification the server had
// already queued would be read before its response (one socket, FIFO).
func assertNoNotification(t *testing.T, conn *websocket.Conn, method string) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(wantWithin))
	req, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 9911, "method": "settings.describe", "params": map[string]any{},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if werr := conn.WriteMessage(websocket.TextMessage, req); werr != nil {
		t.Fatalf("write: %v", werr)
	}
	for {
		_, msg, rerr := conn.ReadMessage()
		if rerr != nil {
			t.Fatalf("read: %v", rerr)
		}
		var env struct {
			ID     *json.RawMessage `json:"id"`
			Method string           `json:"method"`
		}
		_ = json.Unmarshal(msg, &env)
		if env.ID != nil {
			return // the round trip came back; nothing was queued ahead of it
		}
		if env.Method == method {
			t.Fatalf("unexpected %s notification: %s", method, msg)
		}
	}
}

// The DTO's own conformance: both values the wire may carry, and the proof
// that the terminal half cannot be sent even if a caller built it. The enum is
// the schema's job and this is where a handler that spelled a value differently
// would be caught.
func TestSessionLiveness_DTOConformsToContract(t *testing.T) {
	schema := loadSchema(t, "session.liveness.schema.json")

	for _, value := range []session.Liveness{session.LivenessAlive, session.LivenessUnknown} {
		raw, err := json.Marshal(livenessNotificationParams{
			SessionID:     "0123456789abcdef0123456789abcdef",
			InstanceID:    "fedcba9876543210fedcba9876543210",
			SessionEpoch:  2,
			Liveness:      string(value),
			LivenessEpoch: 7,
			ObservedAt:    time.Now().UTC().Format(time.RFC3339),
		})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		validateJSON(t, schema, raw, "session.liveness DTO ("+string(value)+")")
	}

	for _, value := range []session.Liveness{session.LivenessDead, session.LivenessInterrupted} {
		raw, err := json.Marshal(livenessNotificationParams{
			SessionID:     "0123456789abcdef0123456789abcdef",
			InstanceID:    "fedcba9876543210fedcba9876543210",
			SessionEpoch:  2,
			Liveness:      string(value),
			LivenessEpoch: 7,
			ObservedAt:    time.Now().UTC().Format(time.RFC3339),
		})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if err := validateJSONErr(schema, raw); err == nil {
			t.Errorf("the schema accepts %q: the terminal half of the vocabulary is the exit notification's, and a shape that cannot exist must not be sendable", value)
		}
	}
}

// A local session is on this machine, so the reachability axis has nothing to
// say about it and the registry's host-keyed observations never name it. The
// projection still exists and still reads alive — the record is not remote-only
// even though the only producer today is.
func TestLiveness_ALocalSessionIsAlive(t *testing.T) {
	reg := session.New(log.NewSlogAdapter(nil), &stubPTYFactory{stub: pty.NewStub(log.NewSlogAdapter(nil))})
	sess, err := reg.Open(context.Background(), session.Config{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if got := sess.Liveness().Liveness; got != session.LivenessAlive {
		t.Errorf("liveness = %q, want %q", got, session.LivenessAlive)
	}
}
