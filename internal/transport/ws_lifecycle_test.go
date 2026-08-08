package transport

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/lifecyclepub"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/session"
)

// lifecycleTestEnv boots a WSServer and connects one client, exactly like the
// files and git test envs; lifecycle wiring is added per test because only
// some of them need a publisher.
type lifecycleTestEnv struct {
	ws   *WSServer
	conn *websocket.Conn
}

func newLifecycleTestEnv(t *testing.T, opts ...WSServerOption) *lifecycleTestEnv {
	t.Helper()
	logger := log.NewSlogAdapter(nil)
	reg := newRegWithStub(logger)
	ws := NewWSServer(logger, reg, opts...)
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })
	return &lifecycleTestEnv{ws: ws, conn: conn}
}

// openSession opens a local session over the env's connection and returns its
// server-authoritative sessionId.
func (e *lifecycleTestEnv) openSession(t *testing.T, id int) string {
	t.Helper()
	return openSessionOnConn(t, e.ws, e.conn, id)
}

// openSessionOnConn opens a local session over an arbitrary connection.
func openSessionOnConn(t *testing.T, ws *WSServer, conn *websocket.Conn, id int) string {
	t.Helper()
	resp := jsonrpcCallWithID(t, conn, "open", map[string]uint16{"cols": 80, "rows": 24}, id)
	var envelope struct {
		Result json.RawMessage  `json:"result"`
		Error  *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(resp, &envelope); err != nil {
		t.Fatalf("open: unmarshal: %v\nraw: %s", err, resp)
	}
	if envelope.Error != nil {
		t.Fatalf("open: %+v", envelope.Error)
	}
	var got struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(envelope.Result, &got); err != nil {
		t.Fatalf("open: decode result: %v", err)
	}
	if got.SessionID == "" {
		t.Fatal("open returned an empty sessionId")
	}
	return got.SessionID
}

// noopPort swallows the kernel's outbound envelopes (accept, refresh_request);
// the shell side is not reading, and the kernel treats send failures as
// best-effort.
type noopPort struct{}

func (noopPort) Send(lifecycle.Envelope) error { return nil }

// lifecycleEnv builds an authenticated envelope for a minted domain handle,
// exactly as a lifecycle adapter would after substituting the capability.
func lifecycleEnv(lane lifecycle.LaneID, h lifecycle.DomainHandle, seq uint64, evt lifecycle.Event) lifecycle.Envelope {
	return lifecycle.Envelope{
		Version: lifecycle.ProtocolVersion, Lane: lane, Domain: h.Domain,
		Epoch: h.Epoch, Sequence: seq, Capability: h.Capability, Event: evt,
	}
}

func lifecycleHelloEvt() lifecycle.Event {
	return lifecycle.Event{Kind: lifecycle.KindHello, Hello: &lifecycle.Hello{Shell: "bash"}}
}

func lifecyclePromptEvt() lifecycle.Event {
	return lifecycle.Event{Kind: lifecycle.KindPromptReady, PromptReady: &lifecycle.PromptReady{}}
}

func lifecycleStartEvt(id *lifecycle.AttemptID, cmd string) lifecycle.Event {
	return lifecycle.Event{Kind: lifecycle.KindStart, Start: &lifecycle.Start{AttemptID: id, Command: cmd}}
}

func lifecycleCompleteEvt(id lifecycle.AttemptID, code int, f lifecycle.FenceNonce) lifecycle.Event {
	return lifecycle.Event{Kind: lifecycle.KindComplete, Complete: &lifecycle.Complete{AttemptID: &id, ExitCode: &code, Fence: f}}
}

func lifecycleFence(n byte) lifecycle.FenceNonce {
	var f lifecycle.FenceNonce
	for i := range f {
		f[i] = n
	}
	return f
}

func mustLifecycleIngest(t *testing.T, pub *lifecyclepub.Publisher, tID lifecycle.TransportID, e lifecycle.Envelope) {
	t.Helper()
	if err := pub.Ingest(tID, e); err != nil {
		t.Fatalf("Ingest: %v", err)
	}
}

// TestLifecycleChanged_NoCapabilityOrRawFrameCrosses is the assertion this
// bead exists for (ADR-0024 decision 7): "no capability and no raw frame ever
// reaches the renderer". It is asserted, not reasoned about, and asserted
// against the ACTUAL serialized payloads off the REAL socket — a future
// refactor that starts including a field it should not fails here. The fence
// is format-identical to the capability (64 hex chars), so the test also
// discriminates on value: the domain's minted capability must never appear,
// while the completion's fence — the render-ordering rendezvous of decision
// 7's carve-out, which carries no authority — is expected and asserted.
func TestLifecycleChanged_NoCapabilityOrRawFrameCrosses(t *testing.T) {
	kernel := lifecycle.New(lifecycle.Options{})
	pub := lifecyclepub.New(kernel)
	e := newLifecycleTestEnv(t)
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
	capHex := hex.EncodeToString(h.Capability[:])
	fence := lifecycleFence(0x51)
	fenceHex := hex.EncodeToString(fence[:])

	// hello first: the domain must be past accept before an attempt can be
	// submitted. The start event then attaches to the app attempt (the
	// kernel requires an authenticated start before a completion).
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 1, lifecycleHelloEvt()))
	att, err := pub.SubmitAttempt(h.Domain, "make", "/work", "local")
	if err != nil {
		t.Fatalf("SubmitAttempt: %v", err)
	}
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 2, lifecycleStartEvt(nil, "make")))
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 3, lifecycleCompleteEvt(att.ID, 0, fence)))
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 4, lifecyclePromptEvt()))

	// Every notification the socket carried during the whole scenario: the
	// hello's prompt_ready, the submit's running, the completion's
	// running(completed), the prompt_ready.
	for i := 0; i < 4; i++ {
		raw := readNotification(t, e.conn, "lifecycle.changed", 5*time.Second)
		if bytes.Contains(raw, []byte(capHex)) {
			t.Fatalf("notification %d carries the domain capability %q: %s", i, capHex, raw)
		}
		// The channel envelope's framing fields — v, dom, seq, cap, evt —
		// have no home in the fact. "dom" is checked as a key, not a bare
		// substring, so "domain" cannot false-positive.
		for _, key := range []string{`"v":`, `"dom":`, `"seq":`, `"cap":`, `"evt":`} {
			if bytes.Contains(raw, []byte(key)) {
				t.Fatalf("notification %d carries a raw envelope field %s: %s", i, key, raw)
			}
		}
		var params lifecyclepub.Fact
		if err := json.Unmarshal(raw, &params); err != nil {
			t.Fatalf("notification %d: decode: %v\nraw: %s", i, err, raw)
		}
		if params.Attempt != nil && params.Attempt.State == lifecyclepub.AttemptCompleted {
			if params.Attempt.Fence != fenceHex {
				t.Fatalf("completion must carry the fence (value-discriminated from the capability), got %q, want %q", params.Attempt.Fence, fenceHex)
			}
		}
	}
}

// TestLifecycleChanged_RoutesToTheLaneSession proves the addressing: a fact
// about one lane reaches that lane's session's connection and never another
// connection's. Positive reads come first — if a fact had leaked to the other
// connection it would have arrived before that connection's own fact and the
// lane assertion would catch it — and the timeout-based negative checks are
// the last reads on each connection, because a gorilla reader stores its
// first read error and returns it forever.
func TestLifecycleChanged_RoutesToTheLaneSession(t *testing.T) {
	kernel := lifecycle.New(lifecycle.Options{})
	pub := lifecyclepub.New(kernel)
	e := newLifecycleTestEnv(t)
	pub.SetEmitter(e.ws)
	sidA := e.openSession(t, 1)
	connB := connectWS(t, e.ws)
	defer func() { _ = connB.Close() }()
	sidB := openSessionOnConn(t, e.ws, connB, 2)

	if err := pub.BindTransport("T", noopPort{}); err != nil {
		t.Fatal(err)
	}
	hA, err := pub.RequestDomain("lane-A", nil, "T")
	if err != nil {
		t.Fatalf("RequestDomain A: %v", err)
	}
	hB, err := pub.RequestDomain("lane-B", nil, "T")
	if err != nil {
		t.Fatalf("RequestDomain B: %v", err)
	}
	e.ws.RegisterLifecycleLane("lane-A", session.ID(sidA))
	e.ws.RegisterLifecycleLane("lane-B", session.ID(sidB))

	mustLifecycleIngest(t, pub, "T", lifecycleEnv("lane-A", hA, 1, lifecycleHelloEvt()))
	raw := readNotification(t, e.conn, "lifecycle.changed", 5*time.Second)
	var params lifecyclepub.Fact
	if err := json.Unmarshal(raw, &params); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if params.Lane != "lane-A" {
		t.Fatalf("fact on A's connection = %+v, want lane-A", params)
	}

	mustLifecycleIngest(t, pub, "T", lifecycleEnv("lane-B", hB, 1, lifecycleHelloEvt()))
	raw = readNotification(t, connB, "lifecycle.changed", 5*time.Second)
	if err := json.Unmarshal(raw, &params); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if params.Lane != "lane-B" {
		t.Fatalf("fact on B's connection = %+v, want lane-B", params)
	}

	// Negative checks LAST on each connection. Had lane-A's fact leaked to
	// B it would already have been consumed above and failed the lane
	// assertion; these catch any extra delivery.
	if leaked := tryReadNotification(t, connB, "lifecycle.changed", 300*time.Millisecond); leaked != nil {
		t.Fatalf("extra fact on B's connection: %s", leaked)
	}
	if leaked := tryReadNotification(t, e.conn, "lifecycle.changed", 300*time.Millisecond); leaked != nil {
		t.Fatalf("lane-B's fact leaked to A's connection: %s", leaked)
	}
}

// TestLifecycleChanged_DroppedWithoutRegistrationAndAfterClose proves the
// safe direction of the boundary: a fact for a lane nobody registered (the
// adapter wiring never landed, or the renderer never attached) is dropped,
// and closing the session clears the registration so no stale route can
// deliver to a dead subscriber. Reads that may time out (the negative
// assertions) are the last reads on each connection, so the close RPC runs
// on a clean connection.
func TestLifecycleChanged_DroppedWithoutRegistrationAndAfterClose(t *testing.T) {
	kernel := lifecycle.New(lifecycle.Options{})
	pub := lifecyclepub.New(kernel)
	e := newLifecycleTestEnv(t)
	pub.SetEmitter(e.ws)
	sid := e.openSession(t, 1)
	connB := connectWS(t, e.ws)
	defer func() { _ = connB.Close() }()
	if err := pub.BindTransport("T", noopPort{}); err != nil {
		t.Fatal(err)
	}
	h, err := pub.RequestDomain("lane-1", nil, "T")
	if err != nil {
		t.Fatalf("RequestDomain: %v", err)
	}

	// Unregistered lane: the fact is dropped — nothing reaches the session's
	// connection. Last read on e.conn.
	mustLifecycleIngest(t, pub, "T", lifecycleEnv("lane-1", h, 1, lifecycleHelloEvt()))
	if raw := tryReadNotification(t, e.conn, "lifecycle.changed", 300*time.Millisecond); raw != nil {
		t.Fatalf("unregistered lane published a fact: %s", raw)
	}

	// Register the lane, then close the session from the clean connection.
	// handleClose only closes sessions in the CALLER's state, so connB
	// attaches first (which also makes it the subscriber from here on);
	// the close clears the lane registration, so a later fact has no route.
	e.ws.RegisterLifecycleLane("lane-1", session.ID(sid))
	at := jsonrpcCallWithID(t, connB, "attach", map[string]any{"sessionId": sid, "offset": 0}, 2)
	var atEnv struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(at, &atEnv); err != nil {
		t.Fatalf("attach: unmarshal: %v", err)
	}
	if atEnv.Error != nil {
		t.Fatalf("attach: %+v", atEnv.Error)
	}
	closeResp := jsonrpcCallWithID(t, connB, "close", map[string]string{"sessionId": sid}, 3)
	var closeEnv struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(closeResp, &closeEnv); err != nil {
		t.Fatalf("close: unmarshal: %v", err)
	}
	if closeEnv.Error != nil {
		t.Fatalf("close: %+v", closeEnv.Error)
	}

	// After close, the fact is dropped again — nothing reaches connB. Last
	// read on connB.
	mustLifecycleIngest(t, pub, "T", lifecycleEnv("lane-1", h, 2, lifecyclePromptEvt()))
	if raw := tryReadNotification(t, connB, "lifecycle.changed", 300*time.Millisecond); raw != nil {
		t.Fatalf("fact delivered after its session closed: %s", raw)
	}
}

// TestLifecycleChanged_ReplayOnAttach proves the AD-9 reconnect resume
// (protocol §12): a reattached frontend receives the session's current
// lifecycle projection even though no transition happened while it was away.
// The replay is what keeps a reattached tab from showing stale authority
// until the next command.
func TestLifecycleChanged_ReplayOnAttach(t *testing.T) {
	kernel := lifecycle.New(lifecycle.Options{})
	pub := lifecyclepub.New(kernel)
	// The server must hold the publisher (WithLifecyclePublisher) for the
	// attach-time replay to have something to replay from; production wires
	// both this and SetEmitter at the composition root.
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
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 1, lifecycleHelloEvt()))
	raw := readNotification(t, e.conn, "lifecycle.changed", 5*time.Second)
	var params lifecyclepub.Fact
	if err := json.Unmarshal(raw, &params); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if params.Lifecycle != lifecyclepub.LifecyclePromptReady {
		t.Fatalf("initial fact = %+v, want prompt_ready", params)
	}

	// Detach (as a network drop would), then reattach from a fresh
	// connection: the current projection must be re-emitted to the NEW
	// subscriber with no transition in between.
	e.ws.getRx(session.ID(sid)).setSubscriber(nil, nil)
	connB := connectWS(t, e.ws)
	defer func() { _ = connB.Close() }()
	at := jsonrpcCallWithID(t, connB, "attach", map[string]any{"sessionId": sid, "offset": 0}, 2)
	var atEnv struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(at, &atEnv); err != nil {
		t.Fatalf("attach: unmarshal: %v", err)
	}
	if atEnv.Error != nil {
		t.Fatalf("attach: %+v", atEnv.Error)
	}

	raw = readNotification(t, connB, "lifecycle.changed", 5*time.Second)
	if err := json.Unmarshal(raw, &params); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if params.Lifecycle != lifecyclepub.LifecyclePromptReady || params.Domain != string(h.Domain) {
		t.Fatalf("replayed fact = %+v, want the current prompt_ready projection", params)
	}
	// Nothing may reach the detached connection (last read on e.conn).
	if leaked := tryReadNotification(t, e.conn, "lifecycle.changed", 300*time.Millisecond); leaked != nil {
		t.Fatalf("replayed fact leaked to the detached connection: %s", leaked)
	}
}
