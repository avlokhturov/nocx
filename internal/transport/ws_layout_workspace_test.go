package transport

// workspaceId is DERIVED (nocx-isoph.2, design §4.5). It moved off the
// session — where nocx-fraus put it as the intermediate step — onto the tab,
// and the backend now resolves pane → tab → workspace itself. The wire is
// unchanged: the open ack still carries workspaceId, never empty, and the
// renderer reads it exactly where it always did.
//
// What these tests hold is the DIFFERENCE between derived and stored. A
// stored copy answers the same as the chain until the moment a pane is
// dragged, and then goes on answering confidently — so the assertion that
// matters is the one taken AFTER a move.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/workspace"
)

// openWorkspace opens a session, optionally naming a pane, and returns the
// workspaceId the ack carried.
func openWorkspace(t *testing.T, conn *websocket.Conn, paneID string, id int) (string, *jsonrpcErrorObj) {
	t.Helper()
	params := map[string]any{"cols": 80, "rows": 24}
	if paneID != "" {
		params["paneId"] = paneID
	}
	raw := jsonrpcCallWithID(t, conn, "open", params, id)
	var env struct {
		Result struct {
			WorkspaceID string `json:"workspaceId"`
		} `json:"result"`
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("open: %v\nraw: %s", err, raw)
	}
	return env.Result.WorkspaceID, env.Error
}

// The chain answers, and it answers with the workspace the PANE is in — not
// with a value anybody sent and not with the default. This is the acceptance
// criterion in one test: resolve a pane's workspace through the chain and get
// the answer the session used to give.
func TestOpenDerivesTheWorkspaceThroughTheChain(t *testing.T) {
	ws, db := newLayoutWSServer(t)
	conn := connectWS(t, ws)
	seedWire(t, conn)

	got, rpcErr := openWorkspace(t, conn, paneID1, 10)
	if rpcErr != nil {
		t.Fatalf("open: %+v", rpcErr)
	}
	if got != wsID1 {
		t.Fatalf("open ack workspaceId = %q, want the pane's workspace %q", got, wsID1)
	}
	// And the store agrees, through the same seam the handler used.
	resolved, err := db.Layout().WorkspaceForPane(context.Background(), paneID1)
	if err != nil {
		t.Fatalf("WorkspaceForPane: %v", err)
	}
	if resolved != got {
		t.Fatalf("the chain says %q and the ack said %q", resolved, got)
	}
}

// The difference a stored copy cannot express: drag the pane into a tab in
// another workspace and the next open answers with the NEW workspace, because
// the answer is walked rather than remembered.
func TestDerivedWorkspaceFollowsThePane(t *testing.T) {
	ws, _ := newLayoutWSServer(t)
	conn := connectWS(t, ws)
	seedWire(t, conn)
	mustLayoutCall(t, conn, "workspaces.create",
		map[string]any{"id": wsID2, "name": "ansible", "position": 1}, 20)
	mustLayoutCall(t, conn, "tabs.create",
		map[string]any{"id": tabID2, "workspaceId": wsID2, "position": 0, "layout": "row"}, 21)

	before, rpcErr := openWorkspace(t, conn, paneID1, 22)
	if rpcErr != nil {
		t.Fatalf("open before: %+v", rpcErr)
	}
	mustLayoutCall(t, conn, "panes.move", map[string]any{"id": paneID1, "tabId": tabID2}, 23)
	after, rpcErr := openWorkspace(t, conn, paneID1, 24)
	if rpcErr != nil {
		t.Fatalf("open after: %+v", rpcErr)
	}
	if before != wsID1 || after != wsID2 {
		t.Fatalf("workspaceId before the move = %q and after = %q, want %q then %q — the answer must follow the pane",
			before, after, wsID1, wsID2)
	}
}

// No pane named is the ordinary case until the renderer mints them
// (nocx-isoph.4), and the invariant is unchanged: NEVER EMPTY, and the
// default is owned by internal/workspace.Default and by nothing else.
func TestOpenWithNoPaneIsInTheDefaultWorkspace(t *testing.T) {
	ws, _ := newLayoutWSServer(t)
	conn := connectWS(t, ws)

	got, rpcErr := openWorkspace(t, conn, "", 30)
	if rpcErr != nil {
		t.Fatalf("open: %+v", rpcErr)
	}
	if got != string(workspace.Default) {
		t.Fatalf("open ack workspaceId = %q, want the default %q", got, workspace.Default)
	}
}

// A paneId naming no pane is REFUSED, and refused before a shell is spawned:
// "the pane you named does not exist" and "you named no pane" are different
// facts, and answering both with the default would hide the first.
func TestOpenRefusesAPaneThatDoesNotExist(t *testing.T) {
	ws, _ := newLayoutWSServer(t)
	conn := connectWS(t, ws)
	seedWire(t, conn)

	_, rpcErr := openWorkspace(t, conn, paneID2, 40)
	if rpcErr == nil || rpcErr.Code != -32602 {
		t.Fatalf("open naming an unknown pane = %+v, want -32602", rpcErr)
	}
	// Nothing was opened: the refusal costs no shell.
	if n := len(ws.registry.List()); n != 0 {
		t.Fatalf("%d sessions exist after a refused open, want 0", n)
	}
}

// With NO content store the chain does not exist, and the honest answer is
// the default rather than a refusal: there is nothing to resolve against, and
// a backend without a layout store must still open a session.
func TestOpenWithoutALayoutStoreIsInTheDefaultWorkspace(t *testing.T) {
	logger := log.NewSlogAdapter(nil)
	ws := NewWSServer(logger, newRegWithStub(logger))
	if err := ws.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(context.Background()) })
	conn := connectWS(t, ws)

	got, rpcErr := openWorkspace(t, conn, "", 50)
	if rpcErr != nil {
		t.Fatalf("open: %+v", rpcErr)
	}
	if got != string(workspace.Default) {
		t.Fatalf("open ack workspaceId = %q, want the default %q", got, workspace.Default)
	}
}
