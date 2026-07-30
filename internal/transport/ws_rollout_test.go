package transport

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/connection"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/rollout"
)

// rolloutHarness wires a WSServer with a registered runner for testing.
type rolloutHarness struct {
	t    *testing.T
	ws   *WSServer
	conn *websocket.Conn
}

func newRolloutHarness(t *testing.T, runner rollout.Runner) *rolloutHarness {
	t.Helper()
	dir := t.TempDir()
	ps := profile.NewJSONStore(dir + "/p.json")
	cs := newTestStore()
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithCredentialMetadataRepository(ps),
		WithCredentialStore(cs))
	if runner != nil {
		ws.rolloutRunner = runner
	}

	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })
	return &rolloutHarness{t: t, ws: ws, conn: conn}
}

type testRunner struct {
	called bool
	params rollout.RunParams
	result *rollout.RunState
}

func (r *testRunner) Run(ctx context.Context, params rollout.RunParams) (*rollout.RunState, error) {
	r.called = true
	r.params = params
	return r.result, nil
}

func TestRolloutRun_Success(t *testing.T) {
	runner := &testRunner{result: &rollout.RunState{Status: rollout.RunStatusCompleted}}
	h := newRolloutHarness(t, runner)

	resp := jsonrpcCall(t, h.conn, "rollout.run", map[string]any{
		"credentialId": "cred:1",
		"versionId":    "v2",
		"targetIds":    []string{"p1"},
	})

	var got struct {
		Result rolloutRunResult `json:"result"`
	}
	if err := json.Unmarshal(resp, &got); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if got.Result.Status != "completed" {
		t.Errorf("expected completed, got %s", got.Result.Status)
	}
}

func TestRolloutRun_MethodNotFound(t *testing.T) {
	h := newRolloutHarness(t, nil)
	resp := jsonrpcCall(t, h.conn, "rollout.nonexistent", map[string]any{})

	var got struct {
		Error struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &got); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if got.Error.Code != -32601 {
		t.Errorf("expected -32601, got %d", got.Error.Code)
	}
}

func TestRolloutRun_ValidatesParams(t *testing.T) {
	runner := &testRunner{result: &rollout.RunState{}}
	h := newRolloutHarness(t, runner)

	tests := []struct {
		name string
		body map[string]any
	}{
		{"empty", map[string]any{}},
		{"no-credential", map[string]any{"versionId": "v", "targetIds": []string{"p"}}},
		{"no-version", map[string]any{"credentialId": "c", "targetIds": []string{"p"}}},
		{"no-targets", map[string]any{"credentialId": "c", "versionId": "v"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runner.called = false
			resp := jsonrpcCall(t, h.conn, "rollout.run", tt.body)
			var got struct {
				Error struct {
					Code int `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(resp, &got); err != nil {
				t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
			}
			if got.Error.Code != -32602 {
				t.Errorf("expected -32602, got %d", got.Error.Code)
			}
		})
	}
}

func TestRolloutRun_ParamsPassThrough(t *testing.T) {
	runner := &testRunner{result: &rollout.RunState{}}
	h := newRolloutHarness(t, runner)

	jsonrpcCall(t, h.conn, "rollout.run", map[string]any{
		"credentialId":       "cred:p:1",
		"versionId":          "v2",
		"targetIds":          []string{"a", "b"},
		"canaryIds":          []string{"c1"},
		"batchSize":          7,
		"globalConcurrency":  4,
		"bastionConcurrency": 2,
	})

	if !runner.called {
		t.Fatal("runner not called")
	}
	if runner.params.CredentialID != "cred:p:1" || runner.params.VersionID != "v2" {
		t.Errorf("id/version: %s/%s", runner.params.CredentialID, runner.params.VersionID)
	}
	if runner.params.BatchSize != 7 || runner.params.GlobalConcurrency != 4 {
		t.Errorf("batch/global: %d/%d", runner.params.BatchSize, runner.params.GlobalConcurrency)
	}
}

func TestRolloutResolverAdapter_NonVersionError(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(dir + "/p.json")
	cs := newTestStore()
	resolver := connection.NewResolver(ps, ps, ps, cs)
	adapter := &rolloutResolverAdapter{inner: resolver}

	_, _, err := adapter.ResolveWithVersion("nonexistent", "cred:x", "v99")
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), "version not found") {
		t.Error("should not convert non-version errors")
	}
}

func TestRolloutCredentialAdapter(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(dir + "/p.json")
	if err := ps.CreateCredential(profile.Credential{
		ID: "cred:t:1", Name: "t", Username: "alice", Auth: "password",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	adapter := &rolloutCredentialAdapter{credRepo: ps}

	mode, err := adapter.AuthMode("cred:t:1")
	if err != nil || mode != "password" {
		t.Errorf("expected password, got mode=%s err=%v", mode, err)
	}

	_, err = adapter.AuthMode("cred:missing:1")
	if err == nil || !strings.Contains(err.Error(), "credential not found") {
		t.Errorf("expected credential not found, got %v", err)
	}
}

// --- the seam between the rollout and the promotion --------------------------

// TestRolloutRunFeedsThePromotionThreshold is the test the two beads could not
// write for themselves: one built the run, the other built the threshold, and
// each was correct in isolation while nothing carried evidence between them.
// It asserts the composition — a rollout in which every endpoint accepts leaves
// the store able to satisfy a promotion at that count.
func TestRolloutRunFeedsThePromotionThreshold(t *testing.T) {
	now := time.Now()
	h := newRolloutHarness(t, &testRunner{result: &rollout.RunState{
		Status: rollout.RunStatusCompleted,
		Probed: []rollout.EndpointResult{
			{ProfileID: "ssh:a:1", Endpoint: "a.example.com:22", Username: "ops", Fingerprint: "SHA256:aaa", AuthPolicy: "password", Outcome: OutcomeAccepted, Timestamp: now},
			{ProfileID: "ssh:b:1", Endpoint: "b.example.com:22", Username: "ops", Fingerprint: "SHA256:bbb", AuthPolicy: "password", Outcome: OutcomeAccepted, Timestamp: now},
			{ProfileID: "ssh:c:1", Endpoint: "c.example.com:22", Username: "ops", Fingerprint: "SHA256:ccc", AuthPolicy: "password", Outcome: OutcomeRejected, Timestamp: now},
		},
		Excluded: []rollout.Exclusion{
			{ProfileID: "ssh:d:1", Endpoint: "d.example.com:22", Reason: "host-key-problem"},
		},
		StartedAt: now,
	}})
	h.ws.probeResultStore = NewProbeResultStore()

	jsonrpcCall(t, h.conn, "rollout.run", map[string]any{
		"credentialId": "cred:prod:abc",
		"versionId":    "v2",
		"targetIds":    []string{"ssh:a:1", "ssh:b:1", "ssh:c:1", "ssh:d:1"},
	})

	stored := h.ws.probeResultStore.List()
	if len(stored) != 3 {
		t.Fatalf("stored %d results, want 3 — one per PROBED endpoint, and none for the excluded one", len(stored))
	}

	accepted := 0
	for _, r := range stored {
		if r.CredentialID != "cred:prod:abc" {
			t.Errorf("record CredentialID = %q, want cred:prod:abc", r.CredentialID)
		}
		if r.Identity.CredentialVersion != "v2" {
			t.Errorf("record CredentialVersion = %q, want v2 — the promotion looks results up by version", r.Identity.CredentialVersion)
		}
		if r.Identity.AuthPolicy == "" {
			t.Error("record AuthPolicy is empty; it is part of the identity key in spec §6")
		}
		if r.Outcome == OutcomeAccepted {
			accepted++
		}
	}
	if accepted != 2 {
		t.Errorf("accepted = %d, want 2 — a promotion asking for 2 must be satisfiable and one asking for 3 must not", accepted)
	}

	// The excluded endpoint must not have become evidence: a host nobody
	// reached cannot count towards permission to promote.
	for _, r := range stored {
		if r.ProfileID == "ssh:d:1" {
			t.Error("the excluded endpoint was stored as a probe result")
		}
	}
}
