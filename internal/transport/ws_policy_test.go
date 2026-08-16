package transport

// policy.get / policy.set over the real socket: the ONE global agent policy
// the run grants are minted from (ADR-0020 §7 as amended — amendment
// proposed, awaiting owner approval). The tool-name rule is asserted by
// trying here, at the wire: a policy that names a tool is an invalid-params
// error, and there is no other vocabulary in which to express one.

import (
	"encoding/json"
	"testing"

	"github.com/shady2k/nocx/internal/assistant"
	"github.com/shady2k/nocx/internal/content"
	"github.com/shady2k/nocx/internal/storage"
)

// newPolicyHarness builds a server with the composition root's policy seam
// wired: a real GlobalPolicyStore over a real DocumentStore. The store is
// returned so tests seed and read the value the mint uses — no type
// assertion on the server's seam.
func newPolicyHarness(t *testing.T) (*askHarness, *assistant.GlobalPolicyStore) {
	t.Helper()
	store := assistant.NewGlobalPolicyStore(storage.NewDocumentStore(t.TempDir()), "agent-policy.json")
	return newAskHarnessWithOpts(t, mustClient(t), WithAgentPolicy(store)), store
}

func mustClient(t *testing.T) assistant.Client {
	t.Helper()
	client, err := assistant.NewClient(nil)
	if err != nil {
		t.Fatalf("assistant.NewClient: %v", err)
	}
	return client
}

// TestPolicyGet_ReturnsTheEffectivePolicy checks the matrix travels whole:
// every row present with its effective decision (unstated rows ask), and the
// scope a person expressed comes back.
func TestPolicyGet_ReturnsTheEffectivePolicy(t *testing.T) {
	h, store := newPolicyHarness(t)
	var p content.EffectPolicy
	p.Observe = content.EffectRow{
		Decision: content.DecisionPermit,
		Scopes:   []content.GrantScope{{Kind: content.ResourcePath, ID: "/home"}},
	}
	p.MutateDestructive = content.EffectRow{Decision: content.DecisionRefuse}
	if err := store.SetPolicy(p); err != nil {
		t.Fatalf("seed policy: %v", err)
	}

	raw := jsonrpcCall(t, h.conn, "policy.get", nil)
	var env struct {
		Result policyResult `json:"result"`
		Error  *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("policy.get response %s: %v", raw, err)
	}
	if env.Error != nil {
		t.Fatalf("policy.get error: %+v (%s)", env.Error, raw)
	}
	if got := env.Result.Policy.DecisionFor(content.EffectObserve); got != content.DecisionPermit {
		t.Fatalf("observe decision = %s, want permit", got)
	}
	if got := env.Result.Policy.DecisionFor(content.EffectMutateDestructive); got != content.DecisionRefuse {
		t.Fatalf("mutate-destructive decision = %s, want refuse", got)
	}
	if got := env.Result.Policy.DecisionFor(content.EffectDelegate); got != content.DecisionAsk {
		t.Fatalf("unstated delegate decision = %s, want ask", got)
	}
}

// TestPolicySet_PersistsAndTheRunMintSeesIt sets a finer-than-presets
// policy over the socket and asserts the persisted store — the value the
// next ask run's grant is minted from — carries it.
func TestPolicySet_PersistsAndTheRunMintSeesIt(t *testing.T) {
	h, store := newPolicyHarness(t)

	raw := jsonrpcCall(t, h.conn, "policy.set", map[string]any{
		"policy": map[string]any{
			"observe": map[string]any{
				"decision": "permit",
				"scopes":   []any{map[string]any{"kind": "path", "id": "/home/me"}},
			},
		},
	})
	var envelope struct {
		Error *jsonrpcErrorObj `json:"error"`
		OK    bool             `json:"ok"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("policy.set %s: %v", raw, err)
	}
	if envelope.Error != nil {
		t.Fatalf("policy.set error: %+v", envelope.Error)
	}
	if got := store.Policy().DecisionFor(content.EffectObserve); got != content.DecisionPermit {
		t.Fatalf("store policy decides observe = %s, want permit — the mint reads this value", got)
	}
	if got := store.Policy().DecisionFor(content.EffectCrossBoundary); got != content.DecisionAsk {
		t.Fatalf("unstated cross-boundary = %s, want ask", got)
	}
}

// TestPolicySet_NoConfigurationPathNamesATool drives the wire's own refusal:
// a policy that keys a row by a tool name, and one whose row carries a
// tool-kind scope, are invalid params — there is no set that sticks.
func TestPolicySet_NoConfigurationPathNamesATool(t *testing.T) {
	h, _ := newPolicyHarness(t)
	for _, params := range []map[string]any{
		{"policy": map[string]any{"readScreen": map[string]any{"decision": "permit"}}},
		{"policy": map[string]any{"observe": map[string]any{
			"decision": "permit",
			"scopes":   []any{map[string]any{"kind": "tool", "id": "readScreen"}},
		}}},
	} {
		raw := jsonrpcCall(t, h.conn, "policy.set", params)
		var env struct {
			Error *jsonrpcErrorObj `json:"error"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("policy.set %s: %v", raw, err)
		}
		if env.Error == nil || env.Error.Code != -32602 {
			t.Fatalf("policy.set with a tool name (%v) = %s, want -32602 invalid params", params, raw)
		}
	}
}

// TestPolicyGet_UnwiredIsUnavailable: without the composition root's seam,
// the methods answer method-not-found — the state before a policy is named.
func TestPolicyGet_UnwiredIsUnavailable(t *testing.T) {
	h := newAskHarness(t, mustClient(t)) // no WithAgentPolicy
	raw := jsonrpcCall(t, h.conn, "policy.get", nil)
	var env struct {
		Error *jsonrpcErrorObj `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("policy.get %s: %v", raw, err)
	}
	if env.Error == nil || env.Error.Code != -32601 {
		t.Fatalf("policy.get without wiring = %s, want -32601", raw)
	}
}
