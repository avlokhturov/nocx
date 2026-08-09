package transport

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"strings"
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

// ackEstablishmentFrom reads the published prompt_ready fact for the lane,
// extracts the establishment generation and acknowledges it — the renderer's
// decision-9 step, driven directly at the publisher (the wire-level ack RPC
// is covered by the establishAck tests). The domain is not live before this.
func ackEstablishmentFrom(t *testing.T, pub *lifecyclepub.Publisher, lane lifecycle.LaneID, h lifecycle.DomainHandle, conn *websocket.Conn) {
	t.Helper()
	raw := readNotification(t, conn, "lifecycle.changed", 5*time.Second)
	var ready lifecyclepub.Fact
	if err := json.Unmarshal(raw, &ready); err != nil {
		t.Fatalf("decode prompt_ready: %v\nraw: %s", err, raw)
	}
	if ready.Generation == "" {
		t.Fatalf("published fact carries no establishment generation: %+v", ready)
	}
	if err := pub.AcknowledgeEstablishment(lane, h.Domain, h.Epoch, ready.Generation); err != nil {
		t.Fatalf("AcknowledgeEstablishment: %v", err)
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
	// submitted. The renderer's acknowledgement is what makes it live
	// (decision 9); the hello's prompt_ready fact carries the generation
	// and is itself checked for the no-capability/no-raw-frame property
	// below, then acknowledged.
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 1, lifecycleHelloEvt()))
	first := readNotification(t, e.conn, "lifecycle.changed", 5*time.Second)
	checkFactClean(t, first, capHex, fenceHex, fence)
	var ready lifecyclepub.Fact
	if derr := json.Unmarshal(first, &ready); derr != nil {
		t.Fatalf("decode prompt_ready: %v\nraw: %s", derr, first)
	}
	if ready.Generation == "" {
		t.Fatal("the hello's fact must carry the establishment generation")
	}
	if aerr := pub.AcknowledgeEstablishment(lane, h.Domain, h.Epoch, ready.Generation); aerr != nil {
		t.Fatalf("AcknowledgeEstablishment: %v", aerr)
	}
	att, err := pub.SubmitAttempt(h.Domain, "make", "/work", "local")
	if err != nil {
		t.Fatalf("SubmitAttempt: %v", err)
	}
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 2, lifecycleStartEvt(nil, "make")))
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 3, lifecycleCompleteEvt(att.ID, 0, fence)))
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 4, lifecyclePromptEvt()))

	// The remaining notifications the socket carried during the scenario:
	// the submit's running, the completion's running(completed), the
	// prompt_ready.
	for i := 0; i < 3; i++ {
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
	// WithLifecyclePublisher: the attach-time replay needs the server to
	// hold the publisher.
	e := newLifecycleTestEnv(t, WithLifecyclePublisher(pub))
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
	// The attach replays the current projection to connB; its generation is
	// what the renderer would acknowledge (decision 9), making the domain
	// live so the post-close event below is a REAL fact with no route.
	rawReplay := readNotification(t, connB, "lifecycle.changed", 5*time.Second)
	var replay lifecyclepub.Fact
	if err := json.Unmarshal(rawReplay, &replay); err != nil {
		t.Fatalf("decode replay: %v", err)
	}
	if err := pub.AcknowledgeEstablishment("lane-1", h.Domain, h.Epoch, replay.Generation); err != nil {
		t.Fatalf("AcknowledgeEstablishment: %v", err)
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
	// read on connB. The event is accepted (the domain is live), so the
	// drop is a routing property, not a rejection.
	if err := pub.Ingest("T", lifecycleEnv("lane-1", h, 2, lifecyclePromptEvt())); err != nil {
		t.Fatalf("prompt_ready after close: %v", err)
	}
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

// TestLifecycleChanged_ReplayOnAttachAfterLoss is the revoke branch of
// protocol §12's reconnect rule ("either resume the existing domain or
// report ambiguity and revoke it"): when the transport died while the
// frontend was away, a reattach replays the CURRENT projection — the lost
// fact — so the frontend revokes its domains. The replay is a delivery of
// what the kernel concluded, never a resurrection: no new epoch is minted,
// no accept is answered, and the domain stays permanently Lost.
func TestLifecycleChanged_ReplayOnAttachAfterLoss(t *testing.T) {
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
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 1, lifecycleHelloEvt()))
	_ = readNotification(t, e.conn, "lifecycle.changed", 5*time.Second) // prompt_ready

	// The SSH transport dies while the frontend is detached. The lost fact
	// is published (and consumed here); the domain is permanently lost.
	if err := pub.TransportLost("T"); err != nil {
		t.Fatalf("TransportLost: %v", err)
	}
	lost := readNotification(t, e.conn, "lifecycle.changed", 5*time.Second)
	var lostParams lifecyclepub.Fact
	if err := json.Unmarshal(lost, &lostParams); err != nil {
		t.Fatalf("decode lost: %v", err)
	}
	if lostParams.Lifecycle != lifecyclepub.LifecycleLost {
		t.Fatalf("fact after loss = %+v, want lost", lostParams)
	}

	// Detach and reattach: the replay must re-emit the LOST projection.
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
	raw := readNotification(t, connB, "lifecycle.changed", 5*time.Second)
	if err := json.Unmarshal(raw, &lostParams); err != nil {
		t.Fatalf("decode replay: %v", err)
	}
	if lostParams.Lifecycle != lifecyclepub.LifecycleLost {
		t.Fatalf("replayed fact after loss = %+v, want lost (revoke, never resume)", lostParams)
	}
	// No resurrection: the domain is still the same permanently-lost one,
	// with its epoch untouched — the reattach minted nothing.
	if d, ok := pub.Domain(h.Domain); !ok || d.State != lifecycle.DomainLost {
		t.Fatalf("domain after loss+reattach = %+v (ok=%v), want DomainLost", d, ok)
	}
	if d, ok := pub.Domain(h.Domain); ok && d.Epoch != h.Epoch {
		t.Fatalf("epoch changed on reattach: %d != %d", d.Epoch, h.Epoch)
	}
}

// ── lifecycle.submitAttempt (ADR-0024 decision 5) ─────────────────────────

// decodeSubmitAttemptResult decodes the raw result of a lifecycle.submitAttempt
// response and fails on a JSON-RPC error.
func decodeSubmitAttemptResult(t *testing.T, resp json.RawMessage) lifecycleSubmitAttemptResult {
	t.Helper()
	var envelope struct {
		Result json.RawMessage  `json:"result"`
		Error  *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(resp, &envelope); err != nil {
		t.Fatalf("submitAttempt: unmarshal: %v\nraw: %s", err, resp)
	}
	if envelope.Error != nil {
		t.Fatalf("submitAttempt: %+v", envelope.Error)
	}
	var got lifecycleSubmitAttemptResult
	if err := json.Unmarshal(envelope.Result, &got); err != nil {
		t.Fatalf("submitAttempt: decode result: %v", err)
	}
	return got
}

// submitAttemptErr drives lifecycle.submitAttempt through the real socket and
// returns the JSON-RPC error object, failing when the call succeeded.
func submitAttemptErr(t *testing.T, conn *websocket.Conn, params map[string]string, id int) *jsonrpcErrorObj {
	t.Helper()
	resp := jsonrpcCallWithID(t, conn, "lifecycle.submitAttempt", params, id)
	var envelope struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(resp, &envelope); err != nil {
		t.Fatalf("submitAttempt: unmarshal: %v\nraw: %s", err, resp)
	}
	if envelope.Error == nil {
		t.Fatalf("submitAttempt: expected an error, got %s", resp)
	}
	return envelope.Error
}

// TestLifecycleSubmitAttempt_StartAttachesAndReplacesNothing proves the seam
// the renderer reaches (ADR-0024 decision 5): the app-owned submit opens the
// attempt through the control plane BEFORE the pty bytes, the attempt carries
// the app-owned command/cwd/host, and the shell's later authenticated start
// ATTACHES to it — the attempt id, command text, cwd and host are replaced by
// nothing, and the shell's own line (which may carry vault-resolved secrets)
// is ignored outright.
func TestLifecycleSubmitAttempt_StartAttachesAndReplacesNothing(t *testing.T) {
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
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 1, lifecycleHelloEvt()))
	// The renderer acknowledges the published fact; only then is the domain
	// live past accept (decision 9).
	ackEstablishmentFrom(t, pub, lane, h, e.conn)

	const command = "make && echo done"
	const cwd = "/srv/app"
	const host = "build.example.com"
	got := decodeSubmitAttemptResult(t, jsonrpcCallWithID(t, e.conn, "lifecycle.submitAttempt",
		map[string]string{"domain": string(h.Domain), "command": command, "cwd": cwd, "host": host}, 41))
	if got.State != lifecyclepub.AttemptOpen || got.Origin != lifecyclepub.OriginApp {
		t.Fatalf("result = %+v, want an open app-originated attempt", got)
	}
	if got.ID == "" || got.Domain != string(h.Domain) {
		t.Fatalf("result = %+v, want an id and the submitted domain", got)
	}
	if got.Command != command || got.Cwd != cwd || got.Host != host {
		t.Fatalf("result = %+v, want the app-owned command/cwd/host echoed", got)
	}

	// The kernel holds the attempt, not yet started, and the lane runs it.
	att, ok := pub.Attempt(lifecycle.AttemptID(got.ID))
	if !ok {
		t.Fatalf("attempt %q not in the kernel", got.ID)
	}
	if att.Started {
		t.Fatal("attempt started before the shell's authenticated start")
	}
	if att.Command != command || att.Cwd != cwd || att.Host != host || att.Origin != lifecycle.OriginApp {
		t.Fatalf("kernel attempt = %+v, want the app-owned fields", att)
	}
	st, err := pub.State(lane)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if st.Lifecycle != lifecycle.LifecycleRunning || st.Attempt != lifecycle.AttemptID(got.ID) {
		t.Fatalf("lane state = %+v, want running with %q", st, got.ID)
	}

	// A second submit over the pending attempt is refused: the app opens
	// exactly one attempt per submit, and the ordering rule means there is
	// never a second one waiting.
	errObj := submitAttemptErr(t, e.conn, map[string]string{
		"domain": string(h.Domain), "command": "git status", "cwd": cwd, "host": host,
	}, 42)
	if errObj.Code != -32602 {
		t.Fatalf("second submitAttempt code = %d, want -32602", errObj.Code)
	}

	// The authenticated start attaches: same id, replaces nothing, and the
	// shell's line — which may carry a resolved secret — is ignored.
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 2, lifecycleStartEvt(nil, "shell-saw-a-different-line")))
	att, ok = pub.Attempt(lifecycle.AttemptID(got.ID))
	if !ok {
		t.Fatalf("attempt %q lost after the start", got.ID)
	}
	if !att.Started {
		t.Fatal("authenticated start did not attach")
	}
	if att.Command != command {
		t.Fatalf("start replaced the app command: %q", att.Command)
	}
	if att.Cwd != cwd || att.Host != host {
		t.Fatalf("start replaced cwd/host: %+v", att)
	}
	if att.Origin != lifecycle.OriginApp {
		t.Fatalf("start changed the origin: %v", att.Origin)
	}
}

// TestLifecycleSubmitAttempt_RefusesWithoutALiveDomain proves the boundary's
// safe direction: a submit naming no live domain opens no attempt — a
// conventional terminal stays conventional, and an empty command (a bare
// newline) is not an execution and never becomes one.
func TestLifecycleSubmitAttempt_RefusesWithoutALiveDomain(t *testing.T) {
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

	errObj := submitAttemptErr(t, e.conn, map[string]string{
		"domain": "dom-nope", "command": "make", "cwd": "/srv/app", "host": "build.example.com",
	}, 41)
	if errObj.Code != -32602 {
		t.Fatalf("unknown domain code = %d, want -32602", errObj.Code)
	}
	if _, ok := kernel.OpenAttempt("dom-nope"); ok {
		t.Fatal("an attempt was fabricated for an unknown domain")
	}

	errObj = submitAttemptErr(t, e.conn, map[string]string{
		"domain": "dom-nope", "command": "", "cwd": "", "host": "",
	}, 42)
	if errObj.Code != -32602 {
		t.Fatalf("empty command code = %d, want -32602", errObj.Code)
	}
}

// TestLifecycleSubmitAttempt_IsScopedToTheOwningSession proves the mutating
// call is addressable only by the connection that owns the lane's session: a
// domain id guessed from another session opens nothing.
func TestLifecycleSubmitAttempt_IsScopedToTheOwningSession(t *testing.T) {
	kernel := lifecycle.New(lifecycle.Options{})
	pub := lifecyclepub.New(kernel)
	e := newLifecycleTestEnv(t, WithLifecyclePublisher(pub))
	pub.SetEmitter(e.ws)
	sidA := e.openSession(t, 1)
	const lane = lifecycle.LaneID("lane-1")
	e.ws.RegisterLifecycleLane(lane, session.ID(sidA))
	if err := pub.BindTransport("T", noopPort{}); err != nil {
		t.Fatal(err)
	}
	h, err := pub.RequestDomain(lane, nil, "T")
	if err != nil {
		t.Fatalf("RequestDomain: %v", err)
	}
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 1, lifecycleHelloEvt()))
	ackEstablishmentFrom(t, pub, lane, h, e.conn)

	// A second connection with its own session must not open attempts on
	// session A's domain.
	connB := connectWS(t, e.ws)
	defer func() { _ = connB.Close() }()
	openSessionOnConn(t, e.ws, connB, 2)
	params := map[string]string{
		"domain": string(h.Domain), "command": "make", "cwd": "/srv/app", "host": "build.example.com",
	}
	errObj := submitAttemptErr(t, connB, params, 41)
	if errObj.Code != -32602 {
		t.Fatalf("foreign session code = %d, want -32602", errObj.Code)
	}
	if _, ok := kernel.OpenAttempt(h.Domain); ok {
		t.Fatal("a foreign submit opened an attempt on the domain")
	}

	// The owning connection succeeds with the same payload.
	got := decodeSubmitAttemptResult(t, jsonrpcCallWithID(t, e.conn, "lifecycle.submitAttempt", params, 42))
	if got.ID == "" {
		t.Fatal("owning connection's submit returned no attempt id")
	}
}

// TestLifecycleSubmitAttempt_NotWiredFailsClosed proves the un-wired state:
// with no publisher (no lifecycle adapter can exist), the method refuses
// rather than pretending.
func TestLifecycleSubmitAttempt_NotWiredFailsClosed(t *testing.T) {
	e := newLifecycleTestEnv(t)
	errObj := submitAttemptErr(t, e.conn, map[string]string{
		"domain": "dom-1", "command": "make", "cwd": "/srv/app", "host": "build.example.com",
	}, 41)
	if errObj.Code != -32601 {
		t.Fatalf("unwired code = %d, want -32601", errObj.Code)
	}
}

// ── lifecycle.recoverAck (ADR-0024 decision 8) ────────────────────────────

// recoverEnv boots a publisher + server, establishes a live domain on a
// registered lane, kills the transport, and consumes the lost fact. Returns
// the env, the session id and the lost fact (carrying the recovery
// contract). The composite-ack happy path is the caller's to drive.
func recoverEnv(t *testing.T) (*lifecycleTestEnv, *lifecyclepub.Publisher, string, lifecyclepub.Fact) {
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
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 1, lifecycleHelloEvt()))
	_ = readNotification(t, e.conn, "lifecycle.changed", 5*time.Second) // prompt_ready
	if err := pub.TransportLost("T"); err != nil {
		t.Fatalf("TransportLost: %v", err)
	}
	raw := readNotification(t, e.conn, "lifecycle.changed", 5*time.Second)
	var lost lifecyclepub.Fact
	if err := json.Unmarshal(raw, &lost); err != nil {
		t.Fatalf("decode lost: %v", err)
	}
	if lost.Recovery == nil {
		t.Fatal("a live session's lost fact must carry the recovery contract")
	}
	return e, pub, sid, lost
}

func recoverAckErr(t *testing.T, conn *websocket.Conn, sid, generation string, id int) *jsonrpcErrorObj {
	t.Helper()
	resp := jsonrpcCallWithID(t, conn, "lifecycle.recoverAck", map[string]any{
		"sessionId": sid, "generation": generation,
	}, id)
	var env struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("recoverAck: unmarshal: %v\nraw: %s", err, resp)
	}
	if env.Error == nil {
		t.Fatalf("recoverAck: expected an error, got %s", resp)
	}
	return env.Error
}

// TestLifecycleRecoverAck_CompositeFlow is decision 8's interval, both ends:
// the lane is Lost from the moment the transport dies (never authenticated),
// and only the composite acknowledgement — the renderer matching the
// shell's one-shot recovery fence and applying the conventional presentation
// — moves it to Native. Until the ack lands, the lane is neither
// authenticated nor a usable conventional terminal: it stays Lost.
func TestLifecycleRecoverAck_CompositeFlow(t *testing.T) {
	e, pub, sid, lost := recoverEnv(t)
	if st, _ := pub.State(lifecycle.LaneID(lost.Lane)); st.Lifecycle != lifecycle.LifecycleLost {
		t.Fatalf("lane before ack = %v, want Lost throughout the span", st.Lifecycle)
	}
	// The ack carries session identity and the generation — nothing else.
	// The native transition is published DURING the ack (RecoverLane
	// publishes before the response is written), so it is collected from
	// the same read loop instead of being consumed as a skipped
	// notification by a separate call.
	req, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "lifecycle.recoverAck", "params": map[string]any{
		"sessionId": sid, "generation": lost.Recovery.Generation,
	}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := e.conn.WriteMessage(websocket.TextMessage, req); err != nil {
		t.Fatalf("write ack: %v", err)
	}
	var nativeFact *lifecyclepub.Fact
	ackSeen := false
	for !ackSeen {
		_ = e.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, raw, rerr := e.conn.ReadMessage()
		if rerr != nil {
			t.Fatalf("read: %v", rerr)
		}
		var check struct {
			ID     *json.RawMessage `json:"id"`
			Method string           `json:"method"`
			Error  *jsonrpcErrorObj `json:"error"`
		}
		if err := json.Unmarshal(raw, &check); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if check.ID != nil {
			if check.Error != nil {
				t.Fatalf("recoverAck: %+v", check.Error)
			}
			ackSeen = true
			continue
		}
		if check.Method == "lifecycle.changed" {
			var f lifecyclepub.Fact
			var notif struct {
				Params json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(raw, &notif); err == nil {
				if err := json.Unmarshal(notif.Params, &f); err == nil {
					nativeFact = &f
				}
			}
		}
	}
	if nativeFact == nil || nativeFact.Lifecycle != lifecyclepub.LifecycleNative {
		t.Fatalf("post-ack fact = %+v, want native (the published transition)", nativeFact)
	}
	// The lane is a usable conventional terminal now, and the domain stays
	// permanently lost.
	if st, _ := pub.State(lifecycle.LaneID(lost.Lane)); st.Lifecycle != lifecycle.LifecycleNative {
		t.Fatalf("lane after ack = %v, want Native", st.Lifecycle)
	}
	if d, ok := pub.Domain(lifecycle.DomainID(lost.Domain)); ok && d.State != lifecycle.DomainLost {
		t.Fatalf("domain after ack = %v, want permanently DomainLost", d.State)
	}
}

// TestLifecycleRecoverAck_Rejections is one test per acceptance rule of the
// DECIDED ack contract, written as REJECTIONS (a)-(d):
//   - (a) the params are narrow: a missing sessionId or generation is
//     invalid params;
//   - (b) a generation with no pending episode is refused (never promised,
//     or superseded by a fresh domain);
//   - (c) a lane that is no longer Lost is refused — the ack permits only
//     Lost → Native, it can never revoke a live domain;
//   - (d) a duplicate ack succeeds idempotently, and an ack after the
//     session died is refused.
func TestLifecycleRecoverAck_Rejections(t *testing.T) {
	t.Run("(a) narrow params: missing generation", func(t *testing.T) {
		e, _, sid, _ := recoverEnv(t)
		resp := jsonrpcCallWithID(t, e.conn, "lifecycle.recoverAck", map[string]any{
			"sessionId": sid,
		}, 2)
		var env struct {
			Error *jsonrpcErrorObj `json:"error"`
		}
		if err := json.Unmarshal(resp, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if env.Error == nil || env.Error.Code != -32602 {
			t.Fatalf("missing generation: want -32602, got %+v", env.Error)
		}
	})

	t.Run("(b) no pending episode", func(t *testing.T) {
		// No loss ever happened: nothing is pending, nothing may be acked.
		kernel := lifecycle.New(lifecycle.Options{})
		pub := lifecyclepub.New(kernel)
		e := newLifecycleTestEnv(t, WithLifecyclePublisher(pub))
		pub.SetEmitter(e.ws)
		sid := e.openSession(t, 1)
		errObj := recoverAckErr(t, e.conn, sid, strings.Repeat("11", 32), 2)
		if errObj.Code == 0 {
			t.Fatalf("ack with no episode must be refused, got %+v", errObj)
		}
	})

	t.Run("(b) generation mismatch", func(t *testing.T) {
		e, _, sid, _ := recoverEnv(t)
		// A forged or stale generation: the backend only acks what it
		// promised, so this is refused even though the session is alive.
		errObj := recoverAckErr(t, e.conn, sid, strings.Repeat("22", 32), 2)
		if errObj.Code == 0 {
			t.Fatalf("mismatched generation must be refused, got %+v", errObj)
		}
	})

	t.Run("(c) lane no longer lost refuses the ack", func(t *testing.T) {
		e, pub, sid, lost := recoverEnv(t)
		// While the frontend was away, a NEW domain established on the lane
		// (a fresh epoch — the stack was emptied by the loss). The stale ack
		// must not revoke it: RecoverLane permits only Lost → Native.
		if err := pub.BindTransport("T2", noopPort{}); err != nil {
			t.Fatal(err)
		}
		h2, err := pub.RequestDomain(lifecycle.LaneID(lost.Lane), nil, "T2")
		if err != nil {
			t.Fatalf("RequestDomain after loss: %v", err)
		}
		mustLifecycleIngest(t, pub, "T2", lifecycleEnv(lifecycle.LaneID(lost.Lane), h2, 1, lifecycleHelloEvt()))
		_ = readNotification(t, e.conn, "lifecycle.changed", 5*time.Second) // prompt_ready (fresh domain)
		errObj := recoverAckErr(t, e.conn, sid, lost.Recovery.Generation, 2)
		if errObj.Code == 0 {
			t.Fatalf("an ack over a live lane must be refused, got %+v", errObj)
		}
	})

	t.Run("(d) idempotent duplicate ack", func(t *testing.T) {
		e, pub, sid, lost := recoverEnv(t)
		ack := func(id int) *jsonrpcErrorObj {
			resp := jsonrpcCallWithID(t, e.conn, "lifecycle.recoverAck", map[string]any{
				"sessionId": sid, "generation": lost.Recovery.Generation,
			}, id)
			var env struct {
				Error *jsonrpcErrorObj `json:"error"`
			}
			if err := json.Unmarshal(resp, &env); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			return env.Error
		}
		if errObj := ack(2); errObj != nil {
			t.Fatalf("first ack: %+v", errObj)
		}
		if st, _ := pub.State(lifecycle.LaneID(lost.Lane)); st.Lifecycle != lifecycle.LifecycleNative {
			t.Fatalf("lane after first ack = %v, want Native", st.Lifecycle)
		}
		if errObj := ack(3); errObj != nil {
			t.Fatalf("duplicate ack must be idempotent, got %+v", errObj)
		}
	})

	t.Run("(d) late ack after session death is refused", func(t *testing.T) {
		e, pub, sid, lost := recoverEnv(t)
		// The session dies (its channel is gone) before the ack lands:
		// session death wins, the episode is cancelled, and the late ack is
		// refused. Closing through the registry directly models the death
		// race — closeSession cancels the episode before the registry entry
		// goes, and this order (registry first) is the strictest: the lane
		// is still registered, so the ack's session lookup must fail.
		_ = e.ws.registry.Close(session.ID(sid))
		e.ws.cancelRecovery(session.ID(sid))
		_ = pub
		errObj := recoverAckErr(t, e.conn, sid, lost.Recovery.Generation, 2)
		if errObj.Code == 0 {
			t.Fatalf("a late ack after session death must be refused, got %+v", errObj)
		}
	})
}

// TestLifecycleChanged_DeadSessionGetsNoRecoveryClaim is AC4's negative
// branch at the routing seam: when the session is dead, the lost fact is
// delivered WITHOUT the recovery contract — no restoration is claimed over a
// dead connection — and no episode is opened, so no ack can land.
func TestLifecycleChanged_DeadSessionGetsNoRecoveryClaim(t *testing.T) {
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
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 1, lifecycleHelloEvt()))
	_ = readNotification(t, e.conn, "lifecycle.changed", 5*time.Second) // prompt_ready

	// The session channel is dead; the lane registration outlives it for a
	// moment (the strictest race — the strip path must not depend on the
	// registration having been cleaned up).
	_ = e.ws.registry.Close(session.ID(sid))
	if err := pub.TransportLost("T"); err != nil {
		t.Fatalf("TransportLost: %v", err)
	}
	raw := readNotification(t, e.conn, "lifecycle.changed", 5*time.Second)
	var lost lifecyclepub.Fact
	if err := json.Unmarshal(raw, &lost); err != nil {
		t.Fatalf("decode lost: %v", err)
	}
	if lost.Lifecycle != lifecyclepub.LifecycleLost {
		t.Fatalf("fact = %+v, want lost", lost)
	}
	if lost.Recovery != nil {
		t.Fatalf("a dead session must get NO recovery claim, got %+v", lost.Recovery)
	}
	// And no episode exists: a late ack is refused.
	errObj := recoverAckErr(t, e.conn, sid, strings.Repeat("33", 32), 2)
	if errObj.Code == 0 {
		t.Fatalf("ack over a dead session must be refused, got %+v", errObj)
	}
}

// TestLifecycleRecoverAck_DoubleAckLandsOnce proves the claim→recover→
// resolve serialization from the renderer's side: two acknowledgements fired
// back-to-back (a retry after a dropped response is the realistic shape —
// one connection serializes writes, so this is the closest a single renderer
// can come to a race) both succeed, and the transition lands exactly once:
// the second ack observes the resolved episode and changes nothing.
func TestLifecycleRecoverAck_DoubleAckLandsOnce(t *testing.T) {
	e, pub, sid, lost := recoverEnv(t)
	req := func(id int) []byte {
		b, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "lifecycle.recoverAck", "params": map[string]any{
			"sessionId": sid, "generation": lost.Recovery.Generation,
		}})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return b
	}
	if err := e.conn.WriteMessage(websocket.TextMessage, req(2)); err != nil {
		t.Fatalf("write first ack: %v", err)
	}
	if err := e.conn.WriteMessage(websocket.TextMessage, req(3)); err != nil {
		t.Fatalf("write second ack: %v", err)
	}
	responses := 0
	deadline := time.Now().Add(5 * time.Second)
	for responses < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("only %d ack responses arrived", responses)
		}
		_ = e.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, raw, rerr := e.conn.ReadMessage()
		if rerr != nil {
			t.Fatalf("read: %v", rerr)
		}
		var check struct {
			ID    *json.RawMessage `json:"id"`
			Error *jsonrpcErrorObj `json:"error"`
		}
		if err := json.Unmarshal(raw, &check); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if check.ID == nil {
			continue // the native notification
		}
		if check.Error != nil {
			t.Fatalf("double ack produced an error: %+v", check.Error)
		}
		responses++
	}
	if st, _ := pub.State(lifecycle.LaneID(lost.Lane)); st.Lifecycle != lifecycle.LifecycleNative {
		t.Fatalf("lane after double ack = %v, want Native", st.Lifecycle)
	}
}

// checkFactClean asserts the no-capability/no-raw-frame property of one
// published fact (ADR-0024 decision 7): the domain capability never appears,
// none of the channel framing keys appear, and a completed attempt carries
// exactly its own fence.
func checkFactClean(t *testing.T, raw []byte, capHex, fenceHex string, fence lifecycle.FenceNonce) {
	t.Helper()
	if bytes.Contains(raw, []byte(capHex)) {
		t.Fatalf("notification carries the domain capability %q: %s", capHex, raw)
	}
	for _, key := range []string{`"v":`, `"dom":`, `"seq":`, `"cap":`, `"evt":`} {
		if bytes.Contains(raw, []byte(key)) {
			t.Fatalf("notification carries a raw envelope field %s: %s", key, raw)
		}
	}
	var params lifecyclepub.Fact
	if err := json.Unmarshal(raw, &params); err != nil {
		t.Fatalf("decode: %v\nraw: %s", err, raw)
	}
	if params.Attempt != nil && params.Attempt.State == lifecyclepub.AttemptCompleted {
		if params.Attempt.Fence != fenceHex {
			t.Fatalf("completion must carry the fence (value-discriminated from the capability), got %q, want %q", params.Attempt.Fence, fenceHex)
		}
	}
}
