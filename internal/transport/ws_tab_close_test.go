package transport

// tab.close and the capture scope (nocx-tsajw): a closed tab's pending
// credential dies with it, and only it. Every test here runs TWO tabs on ONE
// connection, because that is the arrangement the defect lives in — the old
// connection-keyed destroy could not express "one of two tabs closed" (it
// killed both) and could not express a history-record failure in one tab
// without killing the other's offers.
//
// The destruction key is (connection, tab): the tab id is renderer-minted
// and opaque, so a tab id from one connection must never reach another
// connection's captures — asserted over the real socket below, not only in
// the registry unit tests.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/credential"
)

// recordOnTab records one command from one tab over the socket and decodes
// the ack — the "one tab submits" half of the two-tabs-one-connection
// arrangement.
func recordOnTab(t *testing.T, conn *websocket.Conn, line, tabID string, id int) recordAck {
	t.Helper()
	resp := vaultCall(t, conn, "history.record", recordParams(map[string]any{
		"command": line,
		"tabId":   tabID,
	}), id)
	if resp.Error != nil {
		t.Fatalf("history.record (tab %s) error: %+v", tabID, resp.Error)
	}
	var ack recordAck
	if err := json.Unmarshal(resp.Result, &ack); err != nil {
		t.Fatalf("decode ack: %v", err)
	}
	return ack
}

// sendTabClose sends the tab.close notification the renderer sends when a tab
// closes. The params are marshaled from the transport's own struct so the
// behavior test doubles as the over-the-wire conformance check: the shape the
// Go side declares is the shape the server acts on.
func sendTabClose(t *testing.T, conn *websocket.Conn, tabID string) {
	t.Helper()
	payload, err := json.Marshal(tabCloseParams{TabID: tabID})
	if err != nil {
		t.Fatalf("marshal tab.close params: %v", err)
	}
	frame := fmt.Sprintf(`{"jsonrpc":"2.0","method":"tab.close","params":%s}`, payload)
	if err := conn.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
		t.Fatalf("write tab.close: %v", err)
	}
}

// failOnCommandDB is a captureFakeDB whose Add refuses one marker command —
// the history-record failure trigger, scoped to one tab's record so the other
// tab's record still lands. CommandHistory is overridden because the
// promoted one would answer the EMBEDDED fake, routing every record past this
// override.
type failOnCommandDB struct {
	*captureFakeDB
	failOn string
}

func (f *failOnCommandDB) CommandHistory() content.CommandHistoryRepository { return f }

func (f *failOnCommandDB) Add(ctx context.Context, rec content.CommandRecord) (int64, error) {
	if strings.Contains(rec.Command, f.failOn) {
		return 0, errors.New("store exploded (test)")
	}
	return f.captureFakeDB.Add(ctx, rec)
}

// saveCapture is the wire settlement attempt; it returns the JSON-RPC error
// code (0 when the save succeeded).
func saveCapture(t *testing.T, conn *websocket.Conn, captureID string, id int) int {
	t.Helper()
	resp := vaultCall(t, conn, "secrets.captureSave", map[string]any{"captureId": captureID}, id)
	if resp.Error == nil {
		return 0
	}
	return resp.Error.Code
}

// TestTabClose_DestroysOnlyThatTabsCaptures: closing the first of two tabs on
// one connection destroys ITS pending capture and leaves the second's intact —
// and a capture that was never saved or dismissed does not outlive its tab
// (the offer exists at the ack; the save after the close is refused).
func TestTabClose_DestroysOnlyThatTabsCaptures(t *testing.T) {
	clock := time.Unix(1_750_000_000, 0)
	db := newCaptureFakeDB()
	ws, _, stop := newCaptureWSServer(t, db, &clock)
	defer stop()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	ackA := recordOnTab(t, conn, "TOKEN=aaa-bbb-ccc-ddd-eee-fff-111", "tab-a", 1)
	ackB := recordOnTab(t, conn, "TOKEN=mmm-nnn-ooo-ppp-qqq-rrr-222", "tab-b", 2)
	if len(ackA.Captures) != 1 || len(ackB.Captures) != 1 {
		t.Fatalf("captures = %d/%d, want one offer per tab", len(ackA.Captures), len(ackB.Captures))
	}
	captureA, captureB := ackA.Captures[0].ID, ackB.Captures[0].ID

	// The closing event: tab-a dies, tab-b does not.
	sendTabClose(t, conn, "tab-a")

	if code := saveCapture(t, conn, captureA, 3); code != -32010 {
		t.Fatalf("save of tab-a's capture after its tab closed = code %d, want -32010 (capture unknown)", code)
	}
	if code := saveCapture(t, conn, captureB, 4); code != 0 {
		t.Fatalf("save of tab-b's capture after tab-a closed = code %d, want success", code)
	}
}

// TestTabClose_OtherConnectionsTabIdIsUntouchable: the tab identity is
// renderer-minted and opaque, so a tab.close from ONE connection must not
// destroy the same-named tab's captures on ANOTHER connection — the pair key
// (connection, tab) is the authorization boundary, not the id.
func TestTabClose_OtherConnectionsTabIdIsUntouchable(t *testing.T) {
	clock := time.Unix(1_750_000_000, 0)
	db := newCaptureFakeDB()
	ws, _, stop := newCaptureWSServer(t, db, &clock)
	defer stop()

	connA := connectWS(t, ws)
	defer func() { _ = connA.Close() }()
	connB := connectWS(t, ws)
	defer func() { _ = connB.Close() }()

	// Both connections hold a tab that calls itself "tab-1" — each renderer
	// mints its own ids, so this collision is exactly what the pair key
	// exists for.
	ackA := recordOnTab(t, connA, "TOKEN=aaa-bbb-ccc-ddd-eee-fff-333", "tab-1", 1)
	ackB := recordOnTab(t, connB, "TOKEN=mmm-nnn-ooo-ppp-qqq-rrr-444", "tab-1", 2)

	// connA closes ITS tab-1: connB's tab-1 must be untouched.
	sendTabClose(t, connA, "tab-1")

	if code := saveCapture(t, connA, ackA.Captures[0].ID, 3); code != -32010 {
		t.Fatalf("connA's capture after its own tab.close = code %d, want -32010", code)
	}
	if code := saveCapture(t, connB, ackB.Captures[0].ID, 4); code != 0 {
		t.Fatalf("connB's same-named capture after connA's tab.close = code %d, want success", code)
	}
}

// TestHistoryRecordFailure_DestroysOnlyThatTabsCaptures: a history-record
// failure in ONE tab destroys only that tab's pending captures — the other
// tab's offer on the same connection survives (the old connection-keyed
// destroy took both).
func TestHistoryRecordFailure_DestroysOnlyThatTabsCaptures(t *testing.T) {
	clock := time.Unix(1_750_000_000, 0)
	db := &failOnCommandDB{captureFakeDB: newCaptureFakeDB(), failOn: "sudo rm -rf /"}
	ws, _, stop := newCaptureWSServer(t, db, &clock)
	defer stop()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	ackA := recordOnTab(t, conn, "TOKEN=aaa-bbb-ccc-ddd-eee-fff-555", "tab-a", 1)
	ackB := recordOnTab(t, conn, "TOKEN=mmm-nnn-ooo-ppp-qqq-rrr-666", "tab-b", 2)
	captureA, captureB := ackA.Captures[0].ID, ackB.Captures[0].ID

	// tab-a's record fails at the store; tab-a's offer dies with it.
	resp := vaultCall(t, conn, "history.record", recordParams(map[string]any{
		"command": "sudo rm -rf /", // the marker the failing store refuses
		"tabId":   "tab-a",
	}), 3)
	if resp.Error == nil || resp.Error.Code != -32603 {
		t.Fatalf("failing record error = %+v, want -32603", resp.Error)
	}

	if code := saveCapture(t, conn, captureA, 4); code != -32010 {
		t.Fatalf("tab-a's capture after its record failed = code %d, want -32010", code)
	}
	if code := saveCapture(t, conn, captureB, 5); code != 0 {
		t.Fatalf("tab-b's capture after tab-a's record failed = code %d, want success", code)
	}
}

// TestTransportDisconnect_DestroysEverythingOnTheConnection: the one
// destruction event that is genuinely connection-scoped. Both tabs' captures
// die on the disconnect — asserted deliberately, not left to omission — and
// the assertion is on the registry (the socket is gone, so there is no wire
// to ask).
func TestTransportDisconnect_DestroysEverythingOnTheConnection(t *testing.T) {
	clock := time.Unix(1_750_000_000, 0)
	db := newCaptureFakeDB()
	ws, caps, stop := newCaptureWSServerWithRegistry(t, db, &clock)
	defer stop()
	conn := connectWS(t, ws)
	ackA := recordOnTab(t, conn, "TOKEN=aaa-bbb-ccc-ddd-eee-fff-777", "tab-a", 1)
	ackB := recordOnTab(t, conn, "TOKEN=mmm-nnn-ooo-ppp-qqq-rrr-888", "tab-b", 2)
	captureA, captureB := ackA.Captures[0].ID, ackB.Captures[0].ID

	// The offers existed (the opening end of the invariant); the disconnect
	// is the closing end. The destroy is the statement after the
	// broadcast-set removal inside unregisterConn, so poll the set, then
	// poll the registry until the destroy is OBSERVABLE — Dismiss is the
	// probe because it never blocks: unknown means the capture is gone,
	// and a live probe dismisses the capture (a loud failure below, never
	// a hang on a saving capture).
	_ = conn.Close()
	deadline := time.Now().Add(wantWithin)
	for {
		ws.connsMu.Lock()
		gone := len(ws.conns) == 0
		ws.connsMu.Unlock()
		if gone && errors.Is(caps.Dismiss(credential.CaptureID(captureA)), credential.ErrCaptureUnknown) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("disconnect destroy not observable within %s", wantWithin)
		}
		time.Sleep(2 * time.Millisecond)
	}

	for _, c := range []struct {
		id   string
		name string
	}{
		{captureA, "tab-a's capture"},
		{captureB, "tab-b's capture"},
	} {
		if _, err := caps.Reserve(credential.CaptureID(c.id)); !errors.Is(err, credential.ErrCaptureUnknown) {
			t.Fatalf("%s after transport disconnect = %v, want unknown", c.name, err)
		}
	}
}

// TestTabClose_RejectsMalformedNotification: a tab.close with no tabId or a
// non-object payload is refused by the validator before the handler; the
// capture stays pending (a notification has no response, so the assertion is
// that nothing was destroyed).
func TestTabClose_RejectsMalformedNotification(t *testing.T) {
	clock := time.Unix(1_750_000_000, 0)
	db := newCaptureFakeDB()
	ws, _, stop := newCaptureWSServer(t, db, &clock)
	defer stop()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	ack := recordOnTab(t, conn, "TOKEN=aaa-bbb-ccc-ddd-eee-fff-999", "tab-a", 1)
	capture := ack.Captures[0].ID

	for _, frame := range []string{
		`{"jsonrpc":"2.0","method":"tab.close","params":{}}`,
		`{"jsonrpc":"2.0","method":"tab.close","params":"not-an-object"}`,
	} {
		if err := conn.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
			t.Fatalf("write malformed tab.close: %v", err)
		}
	}

	if code := saveCapture(t, conn, capture, 2); code != 0 {
		t.Fatalf("capture after malformed tab.close = code %d, want success", code)
	}
}

// TestTabClose_DTOConformsToContract pins the Go side of the wire shape: the
// struct the handler parses marshals to exactly what contracts/tab.close
// declares (additionalProperties false, tabId required).
func TestTabClose_DTOConformsToContract(t *testing.T) {
	schema := loadSchema(t, "tab.close.schema.json")
	cases := map[string]tabCloseParams{
		"typical tab": {TabID: "3f2a5c1e-8b0d-4e6a-9f2c-1d0b3e4a5f6a"},
		"minimal tab": {TabID: "1"},
		"long tab id": {TabID: strings.Repeat("x", 128)},
	}
	for name, params := range cases {
		t.Run(name, func(t *testing.T) {
			raw, err := json.Marshal(params)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			validateJSON(t, schema, raw, "tab.close params DTO")
		})
	}
}
