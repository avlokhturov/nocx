package transport

// history.status / history.statusChanged — the raise/clear surface that says
// durable command history is not running (nocx-rtg0.15).
//
// These tests drive the real handler over the real socket. What they assert
// is what a user can find out: the method answers, the answer satisfies the
// contract, a raise reaches a connected renderer once per episode, and the
// read path stops claiming a store answered when there is none.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/log"
)

// historyStatusResult is the decoded history.status result for assertions.
// The contract test below is what proves the key set exact; this names only
// the fields an assertion is about.
type historyStatusResult struct {
	Available bool    `json:"available"`
	Reason    *string `json:"reason"`
	Detail    *string `json:"detail"`
}

func decodeHistoryStatus(t *testing.T, resp *vaultRPCResult) historyStatusResult {
	t.Helper()
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
	if resp.Result == nil {
		t.Fatal("expected a result")
	}
	var out historyStatusResult
	if err := json.Unmarshal(resp.Result, &out); err != nil {
		t.Fatalf("decode result: %v\nraw: %s", err, resp.Result)
	}
	return out
}

// ── the default answer ────────────────────────────────────────────────────

// A server whose composition root never raised anything reports history as
// running. The default has to be "available", not "unknown": the renderer
// has one status to read and no third state to render.
func TestHistoryStatus_DefaultIsAvailable(t *testing.T) {
	ws, stop := newHistoryWSServer(t, &fakeHistoryDB{page: content.LedgerPage{HasRows: true}})
	defer stop()
	conn := connectWS(t, ws)
	got := decodeHistoryStatus(t, vaultCall(t, conn, "history.status", map[string]any{}, 1))

	if !got.Available {
		t.Fatal("available = false, want true with nothing raised")
	}
	if got.Reason != nil {
		t.Fatalf("reason = %q, want null while available", *got.Reason)
	}
	if got.Detail != nil {
		t.Fatalf("detail = %q, want null while available", *got.Detail)
	}
}

// ── the raised answer ─────────────────────────────────────────────────────

// The degrade the composition root raises is what the method reports —
// reason and detail both, because "not running" without a why is a dead end
// for the person reading it.
func TestHistoryStatus_RaiseIsVisibleOverTheWire(t *testing.T) {
	st := NewHistoryStatus()
	st.Raise(HistoryDegradeNoKey, "keyring: item not found")
	ws, stop := newHistoryWSServer(t, nil, WithHistoryStatus(st))
	defer stop()
	conn := connectWS(t, ws)
	got := decodeHistoryStatus(t, vaultCall(t, conn, "history.status", map[string]any{}, 1))

	if got.Available {
		t.Fatal("available = true after a raise, want false")
	}
	if got.Reason == nil || *got.Reason != string(HistoryDegradeNoKey) {
		t.Fatalf("reason = %v, want %q", got.Reason, HistoryDegradeNoKey)
	}
	if got.Detail == nil || *got.Detail != "keyring: item not found" {
		t.Fatalf("detail = %v, want the underlying error", got.Detail)
	}
}

// Clearing closes the episode and the method says so — the raise/clear pair
// is why this is a status and not a one-shot notification.
func TestHistoryStatus_ClearRestoresAvailable(t *testing.T) {
	st := NewHistoryStatus()
	st.Raise(HistoryDegradeOpenFailed, "database is locked")
	st.Clear()
	ws, stop := newHistoryWSServer(t, &fakeHistoryDB{page: content.LedgerPage{HasRows: true}}, WithHistoryStatus(st))
	defer stop()
	conn := connectWS(t, ws)
	got := decodeHistoryStatus(t, vaultCall(t, conn, "history.status", map[string]any{}, 1))

	if !got.Available {
		t.Fatal("available = false after Clear, want true")
	}
	if got.Reason != nil {
		t.Fatalf("reason = %q, want null after Clear", *got.Reason)
	}
}

// ── the push ──────────────────────────────────────────────────────────────

// A degrade that arrives while the app is running reaches the renderer
// without it asking. This is the path nocx-rtg0.10 raises through, so it is
// tested from the Raise side rather than from startup.
func TestHistoryStatus_RaiseNotifiesConnectedClient(t *testing.T) {
	st := NewHistoryStatus()
	ws, stop := newHistoryWSServer(t, &fakeHistoryDB{page: content.LedgerPage{HasRows: true}}, WithHistoryStatus(st))
	defer stop()
	conn := connectWS(t, ws)
	// One completed round trip proves the connection is registered before
	// the raise — the notification fan-out reads the connection set, so a
	// raise that beat the registration would be delivered to nobody and the
	// test would time out on a correct server.
	_ = decodeHistoryStatus(t, vaultCall(t, conn, "history.status", map[string]any{}, 1))

	st.Raise(HistoryDegradeInvalidBudget, "history.retentionMiB below minimum")

	params := readNotification(t, conn, "history.statusChanged", 2*time.Second)
	var got historyStatusResult
	if err := json.Unmarshal(params, &got); err != nil {
		t.Fatalf("decode notification params: %v\nraw: %s", err, params)
	}
	if got.Available {
		t.Fatal("notified available = true, want false")
	}
	if got.Reason == nil || *got.Reason != string(HistoryDegradeInvalidBudget) {
		t.Fatalf("notified reason = %v, want %q", got.Reason, HistoryDegradeInvalidBudget)
	}
}

// Once per episode, not once per loss. Raising the same reason again while
// the episode is open must not put a second notice on the user's screen —
// the whole point of a raise/clear shape over a stream of events.
func TestHistoryStatus_RaiseIsIdempotentWithinAnEpisode(t *testing.T) {
	st := NewHistoryStatus()
	var raised int
	st.AddListener(func() { raised++ })

	st.Raise(HistoryDegradeOpenFailed, "database is locked")
	st.Raise(HistoryDegradeOpenFailed, "database is locked")
	st.Raise(HistoryDegradeOpenFailed, "database is locked again")
	if raised != 1 {
		t.Fatalf("listener fired %d times within one episode, want 1", raised)
	}

	st.Clear()
	if raised != 2 {
		t.Fatalf("listener fired %d times after Clear, want 2", raised)
	}
	st.Clear()
	if raised != 2 {
		t.Fatalf("listener fired %d times after a second Clear, want 2", raised)
	}
}

// A different reason is a different degrade, and the sentence on screen
// changes with it — so it announces even while an episode is open.
func TestHistoryStatus_ADifferentReasonAnnounces(t *testing.T) {
	st := NewHistoryStatus()
	var raised int
	st.AddListener(func() { raised++ })

	st.Raise(HistoryDegradeNoKey, "keyring: item not found")
	st.Raise(HistoryDegradeOpenFailed, "database is locked")
	if raised != 2 {
		t.Fatalf("listener fired %d times across two reasons, want 2", raised)
	}
}

// ── the read path tells the same story ────────────────────────────────────

// With durable history down, history.query must not answer as though a store
// had looked and found nothing. It answers source=unavailable and never
// touches the store.
func TestHistoryQuery_UnavailableAnswersUnavailable(t *testing.T) {
	st := NewHistoryStatus()
	st.Raise(HistoryDegradeNoKey, "keyring: item not found")
	fake := &fakeHistoryDB{page: content.LedgerPage{HasRows: true}}
	ws, stop := newHistoryWSServer(t, fake, WithHistoryStatus(st))
	defer stop()
	conn := connectWS(t, ws)
	got := decodeHistoryResult(t, vaultCall(t, conn, "history.query", map[string]any{"scope": "everywhere"}, 1))

	if got.Source != "unavailable" {
		t.Fatalf("source = %q, want unavailable", got.Source)
	}
	if _, calls := fake.recorded(); calls != 0 {
		t.Fatalf("store consulted %d times while unavailable, want 0", calls)
	}
}

// ── the contract ──────────────────────────────────────────────────────────

// The real result off the real socket, in both states. Nothing here names a
// field, so nothing here can omit one: additionalProperties:false plus
// required is what makes the key set exact in both directions.
func TestHistoryStatus_OverTheWireConformsToContract(t *testing.T) {
	schema := loadSchema(t, "history.status.schema.json")

	cases := map[string]*HistoryStatus{
		"available": NewHistoryStatus(),
		"raised": func() *HistoryStatus {
			st := NewHistoryStatus()
			st.Raise(HistoryDegradeOpenFailed, "database is locked")
			return st
		}(),
		// A reason the composition root could not put words to: the detail
		// is null and the answer is still complete.
		"raised without a detail": func() *HistoryStatus {
			st := NewHistoryStatus()
			st.Raise(HistoryDegradeNoKey, "")
			return st
		}(),
	}
	for name, st := range cases {
		t.Run(name, func(t *testing.T) {
			ws, stop := newHistoryWSServer(t, nil, WithHistoryStatus(st))
			defer stop()
			conn := connectWS(t, ws)
			resp := vaultCall(t, conn, "history.status", map[string]any{}, 1)
			if resp.Error != nil {
				t.Fatalf("unexpected error: %+v", resp.Error)
			}
			validateJSON(t, schema, resp.Result, "history.status result")
		})
	}
}

// The notification carries the status shape verbatim — one schema for both,
// because a second declaration of one fact is how the two go out of step.
func TestHistoryStatusChanged_OverTheWireConformsToContract(t *testing.T) {
	schema := loadSchema(t, "history.status.schema.json")
	st := NewHistoryStatus()
	ws, stop := newHistoryWSServer(t, nil, WithHistoryStatus(st))
	defer stop()
	conn := connectWS(t, ws)
	_ = vaultCall(t, conn, "history.status", map[string]any{}, 1)

	st.Raise(HistoryDegradeNoKey, "keyring: item not found")
	params := readNotification(t, conn, "history.statusChanged", 2*time.Second)
	validateJSON(t, schema, params, "history.statusChanged params")
}

// ── the failure path of the fan-out ───────────────────────────────────────

// A raise with nobody connected is not an error and must not block: the
// degrade is a fact about the app, not about any renderer, and the next
// history.status answers it.
func TestHistoryStatus_RaiseWithNoConnections(t *testing.T) {
	st := NewHistoryStatus()
	ws, stop := newHistoryWSServer(t, nil, WithHistoryStatus(st))
	defer stop()

	done := make(chan struct{})
	go func() {
		st.Raise(HistoryDegradeNoKey, "keyring: item not found")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Raise blocked with no connections attached")
	}

	conn := connectWS(t, ws)
	got := decodeHistoryStatus(t, vaultCall(t, conn, "history.status", map[string]any{}, 1))
	if got.Available {
		t.Fatal("available = true, want the raise to have stuck")
	}
}

// A server built without a status at all still answers — the option is
// optional, and a missing composition-root wire must not make the method
// disappear from under a renderer that reads it every render.
func TestHistoryStatus_AnswersWithoutTheOption(t *testing.T) {
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()

	conn := connectWS(t, ws)
	got := decodeHistoryStatus(t, vaultCall(t, conn, "history.status", map[string]any{}, 1))
	if !got.Available {
		t.Fatal("available = false with no status wired, want true")
	}
}
