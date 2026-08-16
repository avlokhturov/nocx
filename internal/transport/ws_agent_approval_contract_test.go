package transport

// The approval wire shapes against their contracts (nocx-z9hj4, contracts/
// README row 3 — the real payload off the real socket, not a test-built
// one): the agent.approvalRequested notification's params satisfy
// agent.approvalRequested.schema.json, and the agent.approve request the
// renderer actually sends satisfies agent.approve.schema.json —
// additionalProperties false, every field required.

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/shady2k/nocx/internal/assistant"
)

// The DTO conformance: field tags, enum spelling and the omitted
// egress-only fields.
func TestAgentApprovalRequested_DTOConformsToContract(t *testing.T) {
	schema := loadSchema(t, "agent.approvalRequested.schema.json")

	cases := map[string]agentApprovalRequested{
		"policy": {
			RunID: "7", Attempt: 1, Tool: "files.read", CallID: "call_1",
			ArgHash: "hash-a", Arguments: `{"path":"/repo/a.txt"}`,
			Reason: "policy",
		},
		"egress with findings": {
			RunID: "7", Attempt: 1, Tool: "files.read", CallID: "call_1",
			ArgHash: "hash-a", Arguments: `{"path":"/repo/a.txt"}`,
			Reason: "egress", WasError: true,
			Findings: []assistant.EgressFinding{{
				Source: assistant.EgressFindingKnown, SecretName: "github-token", Start: 0, End: 5,
			}},
		},
	}
	for name, dto := range cases {
		raw, err := json.Marshal(dto)
		if err != nil {
			t.Fatalf("%s: marshal: %v", name, err)
		}
		validateJSON(t, schema, raw, "agent.approvalRequested DTO ("+name+")")
	}
}

// The real notification off the real socket satisfies its contract — the
// assertion that would catch a field nobody sends.
func TestAgentApprovalRequested_OverTheWireConformsToContract(t *testing.T) {
	schema := loadSchema(t, "agent.approvalRequested.schema.json")
	const args = `{"path":"/repo/a.txt"}`
	client := &scriptedApprovalClient{script: []approvalScriptStep{
		{suspend: policySuspension("files.read", "call_1", args, "hash-a")},
	}}
	h := newAskHarness(t, client)
	h.createEndpoint()
	sid := openLocalSession(t, h.conn)
	if _, errObj := askOverWire(t, h.conn, map[string]any{
		"askId": "ask-1", "sessionId": sid, "question": "please read it", "cwd": "/repo",
	}, 1); errObj != nil {
		t.Fatalf("ask: %+v", errObj)
	}
	raw := readNotification(t, h.conn, "agent.approvalRequested", 5*time.Second)
	validateJSON(t, schema, raw, "agent.approvalRequested params (real socket)")
}

// schema — every binding field required, additionalProperties false — and
// the same literal payload is what the over-the-socket flow accepts.
func TestAgentApprove_ParamsOverTheSocketConformsToContract(t *testing.T) {
	schema := loadSchema(t, "agent.approve.schema.json")
	const args = `{"path":"/repo/a.txt"}`
	client := &scriptedApprovalClient{script: []approvalScriptStep{
		{suspend: policySuspension("files.read", "call_1", args, "hash-a")},
		{deltas: []string{"done"}},
	}}
	h := newAskHarness(t, client)
	h.createEndpoint()
	sid := openLocalSession(t, h.conn)
	res, errObj := askOverWire(t, h.conn, map[string]any{
		"askId": "ask-1", "sessionId": sid, "question": "please read it", "cwd": "/repo",
	}, 1)
	if errObj != nil {
		t.Fatalf("ask: %+v", errObj)
	}
	readNotification(t, h.conn, "agent.approvalRequested", 5*time.Second)

	// The renderer's literal payload — runId as the string the notification
	// carried, never a number a helper would complete the shape with.
	params := `{"runId":` + strconv.Quote(strconv.FormatInt(res.RunID, 10)) +
		`,"attempt":1,"tool":"files.read","callId":"call_1","argHash":"hash-a","approved":true}`
	validateJSON(t, schema, []byte(params), "agent.approve params (renderer's literal payload)")

	got, errObj := approveOverWireRaw(t, h.conn, []byte(params), 2)
	if errObj != nil {
		t.Fatalf("agent.approve with the literal payload: %+v", errObj)
	}
	if got.State != "streaming" {
		t.Fatalf("approve state = %q, want streaming", got.State)
	}
	// The resume ran: the answer streamed and the run completed.
	readNotification(t, h.conn, "agent.runDelta", 5*time.Second)
	raw := readNotification(t, h.conn, "agent.runState", 5*time.Second)
	if !strings.Contains(string(raw), "completed") {
		t.Fatalf("runState = %s, want completed", raw)
	}
}

// approveOverWireRaw drives agent.approve with a LITERAL raw params payload
// — the renderer's bytes, never a helper-completed shape.
func approveOverWireRaw(t *testing.T, conn *websocket.Conn, params json.RawMessage, id int) (approvalWireResult, *jsonrpcErrorObj) {
	t.Helper()
	req, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "agent.approve", "params": params})
	if err != nil {
		t.Fatalf("marshal approve: %v", err)
	}
	if werr := conn.WriteMessage(websocket.TextMessage, req); werr != nil {
		t.Fatalf("write approve: %v", werr)
	}
	for {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, resp, rerr := conn.ReadMessage()
		if rerr != nil {
			t.Fatalf("read approve: %v", rerr)
		}
		var env struct {
			ID     *json.RawMessage   `json:"id"`
			Error  *jsonrpcErrorObj   `json:"error"`
			Result approvalWireResult `json:"result"`
		}
		_ = json.Unmarshal(resp, &env)
		if env.ID == nil {
			continue // a notification; keep looking for the response
		}
		return env.Result, env.Error
	}
}
