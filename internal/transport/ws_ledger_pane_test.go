package transport

// The block's anchor, over the real socket (nocx-rtg0.28, design §6.1).
//
// The pane the entry hangs on is DERIVED FROM THE SESSION, exactly as the
// environment is, and never taken from the envelope. open already says which
// pane the session is the pipe of, and already refuses one that names no pane;
// a second copy on the ledger envelope would be a second surface owning one
// input, and the two would disagree the first time they were allowed to.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// openSessionInPane opens a session that IS the pipe of a pane, and hands back
// the server-authoritative session id. openWorkspace beside it answers the
// other question about the same call — which workspace the ack named — and
// they stay two helpers because a test asserting one must not have to decode
// the other.
func openSessionInPane(t *testing.T, conn *websocket.Conn, paneID string, id int) (string, *jsonrpcErrorObj) {
	t.Helper()
	raw := jsonrpcCallWithID(t, conn, "open", map[string]any{
		"cols": 80, "rows": 24, "paneId": paneID,
	}, id)
	var env struct {
		Result struct {
			SessionID string `json:"sessionId"`
		} `json:"result"`
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("open: %v\nraw: %s", err, raw)
	}
	return env.Result.SessionID, env.Error
}

// The whole bug, at the seam a user reaches: a command recorded in a pane
// comes back anchored on that pane, and the anchor is the one open resolved —
// not one the renderer restated.
func TestLedgerOpen_AnchorsTheEntryOnTheSessionsPane(t *testing.T) {
	ws, db := newLayoutWSServer(t)
	conn := connectWS(t, ws)
	seedWire(t, conn)

	sid, rpcErr := openSessionInPane(t, conn, paneID1, 10)
	if rpcErr != nil {
		t.Fatalf("open in pane: %+v", rpcErr)
	}
	if _, errObj := ledgerCall(t, conn, "ledger.open",
		map[string]any{"envelope": ledgerEnv(sid, "entry-in-a-pane", "make ci", 1)}, 11); errObj != nil {
		t.Fatalf("ledger.open: %+v", errObj)
	}

	row := mustEntry(t, db, "entry-in-a-pane")
	if row.PaneID == nil || *row.PaneID != paneID1 {
		t.Fatalf("entry paneId = %v, want the session's pane %q", row.PaneID, paneID1)
	}
}

// A session that is the pipe of no recorded pane records a block with no
// anchor rather than refusing the write. That is the ordinary state until the
// renderer mints panes for every tab, and losing the command would be a worse
// answer than losing its restore hint — recall is scoped by environment and
// directory, so the block is still findable.
func TestLedgerOpen_WithoutAPaneRecordsAnUnanchoredBlock(t *testing.T) {
	ws, db := newLayoutWSServer(t)
	conn := connectWS(t, ws)
	seedWire(t, conn)

	sid := openLocalSession(t, conn)
	if _, errObj := ledgerCall(t, conn, "ledger.open",
		map[string]any{"envelope": ledgerEnv(sid, "entry-no-pane", "echo hi", 1)}, 11); errObj != nil {
		t.Fatalf("ledger.open: %+v", errObj)
	}

	row := mustEntry(t, db, "entry-no-pane")
	if row.PaneID != nil {
		t.Fatalf("entry paneId = %q, want nil — this session names no pane", *row.PaneID)
	}
}

// The pane id is frontend-minted and UNTRUSTED (design §7), so its SHAPE is
// checked at the wire — before the chain is walked. This is the check open
// never had: a malformed id went straight to WorkspaceForPane, which can only
// answer "no such pane", so "you sent nonsense" and "that pane is gone" came
// back as one fact.
func TestOpen_RefusesAPaneIdThatIsNotAUUIDv7(t *testing.T) {
	ws, _ := newLayoutWSServer(t)
	conn := connectWS(t, ws)
	seedWire(t, conn)

	_, rpcErr := openWorkspace(t, conn, "not-a-uuid", 30)
	if rpcErr == nil || rpcErr.Code != -32602 {
		t.Fatalf("open with a malformed paneId = %+v, want -32602", rpcErr)
	}
	// The CODE alone proves nothing: a malformed id was already refused
	// before this check existed, by the chain walk that can only say "no such
	// pane". What is asserted is that the two facts are now DISTINGUISHABLE —
	// the refusal names the shape, and a well-shaped id naming no pane does
	// not.
	if !strings.Contains(rpcErr.Message, "UUIDv7") {
		t.Fatalf("refusal of a malformed paneId = %q, want it to name the shape", rpcErr.Message)
	}
	_, goneErr := openWorkspace(t, conn, paneID2, 31)
	if goneErr == nil {
		t.Fatal("open naming a well-shaped pane that does not exist succeeded, want a refusal")
	}
	if strings.Contains(goneErr.Message, "UUIDv7") {
		t.Fatalf("refusal of an absent pane = %q, want it NOT to blame the shape", goneErr.Message)
	}
	if n := len(ws.registry.List()); n != 0 {
		t.Fatalf("%d sessions exist after a refused open, want 0", n)
	}
}
