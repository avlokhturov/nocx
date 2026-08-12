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

// awaitIntegration waits for the session to REACH a status, skipping frames
// that report a status it already had.
//
// Skipping them is not leniency, it is the rule: a test waits on a state
// change, and a re-send of the current state is not one. The transport
// re-sends deliberately — the status is a state, replayed on reattach and
// emitted again by the open handler after its ack (AD-7) — and because
// openSession returns as soon as it reads that ack, the handler's emit can
// land at any later moment. It landed after a test had already moved the axis
// on the emulated Linux container, where the handler is slower than the test,
// and read as "the wrong status arrived" (nocx-6au4).
//
// A status that never arrives still fails, on readNotification's own bound.
func awaitIntegration(t *testing.T, conn *websocket.Conn, sid, want string) integrationChangedParams {
	t.Helper()
	for {
		got := readIntegration(t, conn, sid)
		if got.Status == want {
			return got
		}
	}
}

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
	awaitIntegration(t, e.conn, sid, IntegrationStarting)
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
	got := awaitIntegration(t, e.conn, e.sid, IntegrationIntegrated)
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
	got := awaitIntegration(t, e.conn, e.sid, IntegrationConventional)
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
	if got := awaitIntegration(t, e.conn, e.sid, IntegrationConventional); got.Reason != string(ssh.ReasonHandshakeTimeout) {
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
	got := awaitIntegration(t, connB, e.sid, IntegrationConventional)
	if got.Reason != string(ssh.ReasonHandshakeTimeout) {
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

// ── the process observation (nocx-cgzc, nocx-viil.3) ──────────────────────

// The bead's own sentence: a takeover is reported in well under a second,
// and not when the handshake bound expires. Nothing here advances a clock —
// the observation IS the trigger, which is the whole point of having a second
// detector.
func TestIntegration_ShellReplacedIsReportedWithoutWaitingForTheBound(t *testing.T) {
	e := newIntegrationEnv(t)
	e.ws.NoteShellReplaced(session.ID(e.sid), "kiro-cli-term")
	got := awaitIntegration(t, e.conn, e.sid, IntegrationConventional)
	if got.Reason != string(ssh.ReasonHandshakeTimeout) {
		t.Errorf("reason = %q, want handshake-timeout: the same conclusion the bound reaches, reached now", got.Reason)
	}
	if got.Detail == nil || got.Detail.ObservedProcess != "kiro-cli-term" {
		t.Errorf("detail = %+v, want the observed executable's name", got.Detail)
	}
}

// answersAfter collects every session.integrationChanged for a session that
// arrives in a short window and returns the DISTINCT answers in them.
//
// The tests below cannot assert that nothing arrives at all, and the reason is
// the harness rather than the code: openSession returns as soon as the ack is
// read, while the open handler goes on to emit the session's CURRENT status
// after that ack (AD-7), on its own goroutine. So a re-send of a status a test
// has already read can land at any moment, and one did — on the emulated
// Linux container, where the handler is slower than the test.
//
// That re-send is not a defect and must not be asserted away: the status is a
// STATE, replayed on reattach for exactly this reason, and re-sending a state
// says nothing new. What a test may assert — and what the user experiences —
// is that nothing says anything DIFFERENT.
func answersAfter(t *testing.T, conn *websocket.Conn, sid string) []string {
	t.Helper()
	seen := map[string]bool{}
	var answers []string
	for {
		raw := tryReadNotification(t, conn, "session.integrationChanged", 300*time.Millisecond)
		if raw == nil {
			return answers
		}
		var p integrationChangedParams
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatalf("decode session.integrationChanged: %v\nraw: %s", err, raw)
		}
		if p.SessionID != sid {
			continue
		}
		answer := p.Status + "/" + p.Reason
		if p.Detail != nil {
			answer += "/" + p.Detail.ObservedProcess
		}
		if !seen[answer] {
			seen[answer] = true
			answers = append(answers, answer)
		}
	}
}

// One takeover, one answer. The bound still expires ten seconds later and
// still reports its own loss; the axis has already said what that loss would
// say, so the product must not change what it tells the user — a card that
// restates itself differently is a card people learn to ignore.
func TestIntegration_TheBoundExpiringAfterAnObservationSaysNothingNew(t *testing.T) {
	e := newIntegrationEnv(t)
	e.ws.NoteShellReplaced(session.ID(e.sid), "kiro-cli-term")
	awaitIntegration(t, e.conn, e.sid, IntegrationConventional)
	e.ws.NoteIntegrationLoss(e.lane, LossCauseHelloTimeout)
	want := IntegrationConventional + "/" + string(ssh.ReasonHandshakeTimeout) + "/kiro-cli-term"
	for _, answer := range answersAfter(t, e.conn, e.sid) {
		if answer != want {
			t.Errorf("the bound changed the answer to %q, want %q", answer, want)
		}
	}
}

// A loss that arrives after an observation must not DOWNGRADE it either. The
// wrapper closing the inherited descriptor is an end-of-stream, which alone
// means `unknown`; here the backend can say more than that and has already
// said it, and the first answer wins.
func TestIntegration_ALaterLossDoesNotOverwriteTheObservedAnswer(t *testing.T) {
	e := newIntegrationEnv(t)
	e.ws.NoteShellReplaced(session.ID(e.sid), "kiro-cli-term")
	if got := awaitIntegration(t, e.conn, e.sid, IntegrationConventional); got.Reason != string(ssh.ReasonHandshakeTimeout) {
		t.Fatalf("reason = %q, want handshake-timeout", got.Reason)
	}
	e.ws.NoteIntegrationLoss(e.lane, "end-of-stream")
	want := IntegrationConventional + "/" + string(ssh.ReasonHandshakeTimeout) + "/kiro-cli-term"
	for _, answer := range answersAfter(t, e.conn, e.sid) {
		if answer != want {
			t.Errorf("a later loss changed the answer to %q, want %q", answer, want)
		}
	}
}

// An integrated session's shell may legitimately replace its own image, and
// the product must not tear a working session down for it. The observation
// answers only the pre-handshake window; a channel that WAS live and then
// ends is the adapter's loss path, with its own cause and its own reason.
func TestIntegration_AnObservationAfterEstablishmentChangesNothing(t *testing.T) {
	e := newIntegrationEnv(t)
	if got := e.establish(t); got.Status != IntegrationIntegrated {
		t.Fatalf("status = %q, want integrated", got.Status)
	}
	e.ws.NoteShellReplaced(session.ID(e.sid), "kiro-cli-term")
	for _, answer := range answersAfter(t, e.conn, e.sid) {
		if answer != IntegrationIntegrated+"/" {
			t.Errorf("an integrated session was changed to %q by a process observation", answer)
		}
	}
}

// The contract requires a name inside detail, and a guess nobody can name is
// not worth showing: an observation without one is dropped rather than
// flipping a tab to conventional on evidence the user cannot act on.
func TestIntegration_AnUnnamedObservationIsDropped(t *testing.T) {
	e := newIntegrationEnv(t)
	e.ws.NoteShellReplaced(session.ID(e.sid), "")
	for _, answer := range answersAfter(t, e.conn, e.sid) {
		if answer != IntegrationStarting+"/" {
			t.Errorf("an observation with no name moved the session to %q", answer)
		}
	}
}

// A session nobody registered has no axis to move — the same rule the loss
// path already obeys, so an observation about a raw tab stays silent. Absence
// IS assertable here: an unregistered session emits nothing on any path, so
// there is no re-send to race with.
func TestIntegration_AnObservationForAnUnregisteredSessionIsDropped(t *testing.T) {
	e := newLifecycleTestEnv(t)
	sid := e.openSession(t, 1)
	e.ws.NoteShellReplaced(session.ID(sid), "kiro-cli-term")
	if leaked := tryReadNotification(t, e.conn, "session.integrationChanged", 300*time.Millisecond); leaked != nil {
		t.Errorf("an unregistered session announced a status: %s", leaked)
	}
}

// The observation survives a reconnect like every other part of the status
// (AD-9): it is a state, and no further transition is coming to re-deliver
// it.
func TestIntegration_ReattachReplaysTheObservation(t *testing.T) {
	e := newIntegrationEnv(t)
	e.ws.NoteShellReplaced(session.ID(e.sid), "kiro-cli-term")
	if got := awaitIntegration(t, e.conn, e.sid, IntegrationConventional); got.Detail == nil {
		t.Fatal("no detail on the first fact")
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
	got := awaitIntegration(t, connB, e.sid, IntegrationConventional)
	if got.Detail == nil || got.Detail.ObservedProcess != "kiro-cli-term" {
		t.Errorf("replayed detail = %+v, want the observation", got.Detail)
	}
}

// And the paired half of nocx-viil.3: a session where nothing unusual was
// observed sends no detail at all. The details chain must not grow a line
// that says nothing — an empty guess would read as a finding.
func TestIntegration_NothingObservedSendsNoDetail(t *testing.T) {
	e := newIntegrationEnv(t)
	e.ws.NoteIntegrationLoss(e.lane, LossCauseHelloTimeout)
	got := awaitIntegration(t, e.conn, e.sid, IntegrationConventional)
	if got.Reason != string(ssh.ReasonHandshakeTimeout) {
		t.Fatalf("reason = %q, want handshake-timeout", got.Reason)
	}
	if got.Detail != nil {
		t.Errorf("detail = %+v, want none when the backend observed nothing", got.Detail)
	}
}
