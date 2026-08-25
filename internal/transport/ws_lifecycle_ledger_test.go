package transport

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/lifecycle"
	"github.com/shady2k/nocx/internal/lifecyclepub"
	"github.com/shady2k/nocx/internal/session"
)

func newLifecycleLedgerEnv(t *testing.T, withStore bool) (*lifecycleTestEnv, *lifecyclepub.Publisher, lifecycle.LaneID, lifecycle.DomainHandle, string, content.ContentDB) {
	t.Helper()
	var db content.ContentDB
	if withStore {
		db = newLedgerStore(t)
		if _, err := db.Layout().CreateWorkspace(context.Background(),
			content.Workspace{ID: "ws-lifecycle", Name: "lifecycle"},
			content.Tab{ID: "tab-lifecycle", WorkspaceID: "ws-lifecycle", Position: 0, Layout: content.LayoutRow},
			content.Pane{ID: "01930000-0000-7000-8000-0000000000a1", TabID: "tab-lifecycle", Cwd: "/repo", Kind: content.PaneLocal, SizeShare: 1}); err != nil {
			t.Fatalf("CreateWorkspace: %v", err)
		}
	}
	kernel := lifecycle.New(lifecycle.Options{})
	pub := lifecyclepub.New(kernel)
	e := newLifecycleTestEnv(t, WithContentDB(db), WithLifecyclePublisher(pub))
	pub.SetEmitter(e.ws)
	sid := openLifecycleLedgerSession(t, e, "01930000-0000-7000-8000-0000000000a1")
	const lane = lifecycle.LaneID("lane-lifecycle")
	e.ws.RegisterLifecycleLane(lane, session.ID(sid))
	if err := pub.BindTransport("T", noopPort{}); err != nil {
		t.Fatalf("BindTransport: %v", err)
	}
	h, err := pub.RequestDomain(lane, nil, "T")
	if err != nil {
		t.Fatalf("RequestDomain: %v", err)
	}
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 1, lifecycleHelloEvt()))
	ackEstablishmentFrom(t, pub, lane, h, e.conn)
	return e, pub, lane, h, sid, db
}

func openLifecycleLedgerSession(t *testing.T, e *lifecycleTestEnv, paneID string) string {
	t.Helper()
	resp := jsonrpcCallWithID(t, e.conn, "open", map[string]any{
		"cols": 80, "rows": 24, "xpixel": 0, "ypixel": 0, "paneId": paneID,
	}, 1)
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
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(envelope.Result, &result); err != nil {
		t.Fatalf("open: decode result: %v", err)
	}
	if result.SessionID == "" {
		t.Fatal("open returned an empty session id")
	}
	awaitSubscriber(t, e.ws, session.ID(result.SessionID))
	return result.SessionID
}

func lifecycleSubmitParams(domain, command string) map[string]string {
	return map[string]string{
		"domain":  domain,
		"command": command,
		"cwd":     "/repo",
		"host":    "",
	}
}

func TestLifecycleSubmitAttempt_OpensLedgerEntryAtAttemptIDAndMasks(t *testing.T) {
	e, pub, lane, h, sid, db := newLifecycleLedgerEnv(t, true)
	const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ" //nolint:gosec // synthetic detector fixture
	command := "deploy --token=" + secret
	got := decodeSubmitAttemptResult(t, jsonrpcCallWithID(t, e.conn, "lifecycle.submitAttempt", lifecycleSubmitParams(string(h.Domain), command), 41))
	if got.ID == "" {
		t.Fatal("submit returned an empty attempt id")
	}
	row := mustEntry(t, db, got.ID)
	if row.ID != got.ID || row.Phase != content.PhaseOpen || row.Status != content.EntryPending {
		t.Fatalf("submit row = id=%q phase=%q status=%q, want attempt id/open/pending", row.ID, row.Phase, row.Status)
	}
	if row.PaneID == nil || *row.PaneID != "01930000-0000-7000-8000-0000000000a1" {
		t.Fatalf("submit row pane = %v, want lifecycle pane", row.PaneID)
	}
	if strings.Contains(row.Intent, secret) || !strings.Contains(row.Intent, "sk-a...GHIJ") {
		t.Fatalf("stored intent = %q, want masked secret", row.Intent)
	}
	masking, err := content.EntryMaskingOf(row.Payload)
	if err != nil {
		t.Fatalf("EntryMaskingOf: %v", err)
	}
	if masking.MaskedCount != 1 || len(masking.Redactions) != 1 {
		t.Fatalf("stored masking receipt = %+v, want one redaction", masking)
	}
	if _, ok := pub.Attempt(lifecycle.AttemptID(got.ID)); !ok {
		t.Fatalf("attempt %q is absent from the lifecycle kernel", got.ID)
	}
	if items, err := e.ws.ListSessionItems(context.Background(), sid, 10); err != nil {
		t.Fatalf("ListSessionItems while open: %v", err)
	} else if len(items.Items) != 1 || items.Items[0].ID != got.ID || items.Items[0].State != "running" {
		t.Fatalf("running session items = %+v, want one running item %q", items.Items, got.ID)
	}
	_ = lane
}

func TestLifecycleLedgerTransitions_ListAndReadByAttemptID(t *testing.T) {
	e, pub, lane, h, sid, db := newLifecycleLedgerEnv(t, true)
	const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ" //nolint:gosec // synthetic detector fixture
	command := "make test --token=" + secret
	got := decodeSubmitAttemptResult(t, jsonrpcCallWithID(t, e.conn, "lifecycle.submitAttempt", lifecycleSubmitParams(string(h.Domain), command), 41))
	row := mustEntry(t, db, got.ID)
	if row.Phase != content.PhaseOpen {
		t.Fatalf("before start phase = %q, want open", row.Phase)
	}

	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 2, lifecycleStartEvt(nil, command)))
	row = mustEntry(t, db, got.ID)
	if row.Phase != content.PhaseBound || len(row.Executions) != 1 || row.Executions[0].EndedAt != nil {
		t.Fatalf("after authenticated start row = phase=%q executions=%+v, want bound with one live execution", row.Phase, row.Executions)
	}
	items, err := e.ws.ListSessionItems(context.Background(), sid, 10)
	if err != nil {
		t.Fatalf("ListSessionItems while bound: %v", err)
	}
	if len(items.Items) != 1 || items.Items[0].ID != got.ID || items.Items[0].State != "running" {
		t.Fatalf("bound session items = %+v, want one running item %q", items.Items, got.ID)
	}

	fence := lifecycleFence(0x44)
	mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 3, lifecycleCompleteEvt(lifecycle.AttemptID(got.ID), 7, fence)))
	row = mustEntry(t, db, got.ID)
	if row.Phase != content.PhaseClosed || row.Status != content.EntryFailure {
		t.Fatalf("after completion row = phase=%q status=%q, want closed/failure", row.Phase, row.Status)
	}
	recordResp := jsonrpcCallWithID(t, e.conn, "history.record", map[string]any{
		"attemptId": got.ID,
		"command":   command,
		"cwd":       "/repo",
		"host":      "",
		"source":    "user",
		"status":    "failure",
		"exitCode":  7,
		"startedAt": nil,
		"endedAt":   nil,
		"paneId":    "01930000-0000-7000-8000-0000000000a1",
	}, 42)
	var recordEnvelope struct {
		Result json.RawMessage  `json:"result"`
		Error  *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(recordResp, &recordEnvelope); err != nil {
		t.Fatalf("history.record response: %v", err)
	}
	if recordEnvelope.Error != nil {
		t.Fatalf("history.record: %+v", recordEnvelope.Error)
	}
	var ack historyRecordResponse
	if err := json.Unmarshal(recordEnvelope.Result, &ack); err != nil {
		t.Fatalf("history.record result: %v", err)
	}
	if ack.EntryID != got.ID {
		t.Fatalf("history.record entry id = %q, want attempt id %q", ack.EntryID, got.ID)
	}
	entries, err := db.Ledger().ListEntries(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}
	if len(entries) != 1 || entries[0].ID != got.ID {
		t.Fatalf("history.record rows = %+v, want one row under %q", entries, got.ID)
	}
	finalRow := mustEntry(t, db, got.ID)
	if strings.Contains(finalRow.Intent, secret) || !strings.Contains(finalRow.Intent, "sk-a...GHIJ") {
		t.Fatalf("completed row intent = %q, want masked command", finalRow.Intent)
	}
	items, err = e.ws.ListSessionItems(context.Background(), sid, 10)
	if err != nil {
		t.Fatalf("ListSessionItems after completion: %v", err)
	}
	if len(items.Items) != 1 || items.Items[0].ID != got.ID || items.Items[0].State != "exited" || items.Items[0].ExitCode == nil || *items.Items[0].ExitCode != 7 {
		t.Fatalf("completed session items = %+v, want one exited item with code 7", items.Items)
	}
	read, err := e.ws.ReadSessionItem(context.Background(), sid, got.ID, 0, 10)
	if err != nil {
		t.Fatalf("ReadSessionItem by attempt id: %v", err)
	}
	if read.ID != got.ID || read.Command != finalRow.Intent || read.State != "exited" || read.ExitCode == nil || *read.ExitCode != 7 {
		t.Fatalf("read item = %+v, want attempt id, command and exit code", read)
	}
}

func TestLifecycleLedger_AbandonsOpenRowsAsUnknownOnTransportLoss(t *testing.T) {
	t.Run("pty write fails before authenticated start", func(t *testing.T) {
		e, pub, _, h, _, db := newLifecycleLedgerEnv(t, true)
		got := decodeSubmitAttemptResult(t, jsonrpcCallWithID(t, e.conn, "lifecycle.submitAttempt", lifecycleSubmitParams(string(h.Domain), "false"), 41))
		if row := mustEntry(t, db, got.ID); row.Phase != content.PhaseOpen {
			t.Fatalf("before loss phase = %q, want open", row.Phase)
		}
		if err := pub.TransportLost("T"); err != nil {
			t.Fatalf("TransportLost: %v", err)
		}
		row := mustEntry(t, db, got.ID)
		if row.Phase != content.PhaseClosed || row.Status != content.EntryUnknown {
			t.Fatalf("after loss row = phase=%q status=%q, want closed/unknown", row.Phase, row.Status)
		}
	})

	t.Run("process is killed after start", func(t *testing.T) {
		e, pub, lane, h, _, db := newLifecycleLedgerEnv(t, true)
		got := decodeSubmitAttemptResult(t, jsonrpcCallWithID(t, e.conn, "lifecycle.submitAttempt", lifecycleSubmitParams(string(h.Domain), "sleep 1000"), 41))
		mustLifecycleIngest(t, pub, "T", lifecycleEnv(lane, h, 2, lifecycleStartEvt(nil, "sleep 1000")))
		if row := mustEntry(t, db, got.ID); row.Phase != content.PhaseBound {
			t.Fatalf("before kill phase = %q, want bound", row.Phase)
		}
		if err := pub.TransportLost("T"); err != nil {
			t.Fatalf("TransportLost: %v", err)
		}
		row := mustEntry(t, db, got.ID)
		if row.Phase != content.PhaseClosed || row.Status != content.EntryUnknown {
			t.Fatalf("after kill row = phase=%q status=%q, want closed/unknown", row.Phase, row.Status)
		}
	})
}

func TestLifecycleSubmitAttempt_StoreUnavailableStillRunsCommand(t *testing.T) {
	e, pub, lane, h, _, _ := newLifecycleLedgerEnv(t, false)
	got := decodeSubmitAttemptResult(t, jsonrpcCallWithID(t, e.conn, "lifecycle.submitAttempt", lifecycleSubmitParams(string(h.Domain), "echo hi"), 41))
	if got.ID == "" {
		t.Fatal("store-unavailable submit returned an empty attempt id")
	}
	if _, ok := pub.OpenAttempt(h.Domain); !ok {
		t.Fatal("store-unavailable submit did not leave a live kernel attempt")
	}
	state, err := pub.State(lane)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Lifecycle != lifecycle.LifecycleRunning {
		t.Fatalf("state after store degrade = %q, want running", state.Lifecycle)
	}
}
