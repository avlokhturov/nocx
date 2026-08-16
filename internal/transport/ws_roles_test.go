package transport

// The roles wire (bead nocx-e6kn2): roles.list and roles.assign over the
// real socket. The wire shape is declared once in contracts/roles.list.schema.json
// (referenced cross-file by roles.assign's result) and proven over the
// socket at the bottom of this file.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/profile"
)

// listRoles returns the roles table as roles.list sent it.
func (h *endpointHarness) listRoles(t *testing.T) []profile.RoleDTO {
	t.Helper()
	raw := jsonrpcCall(t, h.conn, "roles.list", nil)
	var env struct {
		Error  *struct{ Code int } `json:"error"`
		Result struct {
			Roles []profile.RoleDTO `json:"roles"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("roles.list unmarshal: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("roles.list: code %d\nraw: %s", env.Error.Code, raw)
	}
	return env.Result.Roles
}

func (h *endpointHarness) assignRole(t *testing.T, role string, endpointID, model *string) {
	t.Helper()
	params := map[string]any{"role": role}
	if endpointID != nil {
		params["endpointId"] = *endpointID
		params["model"] = *model
	}
	raw := jsonrpcCall(t, h.conn, "roles.assign", params)
	if isErrorResponse(t, raw) {
		t.Fatalf("roles.assign: %s", raw)
	}
}

// The closed set is visible even with NOTHING configured: an unassigned
// role is a null row, never an absent row — the state the role's failure
// must be visible as.
func TestRolesList_UnassignedRolesAreVisibleNullRows(t *testing.T) {
	h := newEndpointHarness(t)
	roles := h.listRoles(t)
	if len(roles) != 2 {
		t.Fatalf("roles.list = %+v, want exactly the two product roles", roles)
	}
	want := []profile.ModelRole{profile.RoleAnswering, profile.RoleClassifier}
	for i, r := range roles {
		if r.Role != want[i] {
			t.Errorf("roles[%d].role = %q, want %q (product order)", i, r.Role, want[i])
		}
		if r.EndpointID != nil || r.Model != nil {
			t.Errorf("roles[%d] = %q assigned, want null for an unassigned role", i, r.Role)
		}
	}
}

// The assignment a person makes in the product is what roles.list reports
// and what resolution will use.
func TestRolesAssign_ListsWhatWasAssigned(t *testing.T) {
	h := newEndpointHarness(t)
	h.setupAndUnseal()
	created := h.createEndpoint(t, endpointParams("Local", "http://127.0.0.1:11434/v1", "sk-test-123"))
	h.assignRole(t, "answering", &created.ID, strPtr("qwen3"))

	roles := h.listRoles(t)
	byRole := map[profile.ModelRole]profile.RoleDTO{}
	for _, r := range roles {
		byRole[r.Role] = r
	}
	ans := byRole[profile.RoleAnswering]
	if ans.EndpointID == nil || *ans.EndpointID != created.ID || ans.Model == nil || *ans.Model != "qwen3" {
		t.Fatalf("answering role = %+v, want the assigned endpoint+model", ans)
	}
	if cl := byRole[profile.RoleClassifier]; cl.EndpointID != nil {
		t.Errorf("classifier role = %+v, want it untouched (null)", cl)
	}
}

// A second assignment for the same role REPLACES the first: the role has
// exactly one (endpoint, model) pair.
func TestRolesAssign_SecondAssignmentReplacesTheFirst(t *testing.T) {
	h := newEndpointHarness(t)
	h.setupAndUnseal()
	first := h.createEndpoint(t, endpointParams("First", "http://127.0.0.1:11434/v1", "sk-test-123"))
	second := h.createEndpoint(t, endpointParams("Second", "http://127.0.0.1:11434/v1", "sk-test-456"))
	h.assignRole(t, "answering", &first.ID, strPtr("qwen3"))
	h.assignRole(t, "answering", &second.ID, strPtr("local2"))

	var ans profile.RoleDTO
	for _, r := range h.listRoles(t) {
		if r.Role == profile.RoleAnswering {
			ans = r
		}
	}
	if ans.EndpointID == nil || *ans.EndpointID != second.ID || ans.Model == nil || *ans.Model != "local2" {
		t.Fatalf("answering role after reassignment = %+v, want the SECOND pair", ans)
	}
}

// The clear write (both fields empty) returns the role to the visible
// unassigned state — the failure the ask refuses on.
func TestRolesAssign_ClearReturnsTheRoleToUnassigned(t *testing.T) {
	h := newEndpointHarness(t)
	h.setupAndUnseal()
	created := h.createEndpoint(t, endpointParams("Local", "http://127.0.0.1:11434/v1", "sk-test-123"))
	h.assignRole(t, "answering", &created.ID, strPtr("qwen3"))
	h.assignRole(t, "answering", nil, nil)
	for _, r := range h.listRoles(t) {
		if r.Role == profile.RoleAnswering && r.EndpointID != nil {
			t.Fatalf("answering role after clear = %+v, want null", r)
		}
	}
}

func TestRolesAssign_RefusesAnUnknownRoleAndAHalfPair(t *testing.T) {
	h := newEndpointHarness(t)
	h.setupAndUnseal()
	created := h.createEndpoint(t, endpointParams("Local", "http://127.0.0.1:11434/v1", "sk-test-123"))

	for name, params := range map[string]map[string]any{
		"unknown role":           {"role": "invented", "endpointId": created.ID, "model": "qwen3"},
		"endpoint without model": {"role": "answering", "endpointId": created.ID},
		"model without endpoint": {"role": "answering", "model": "qwen3"},
		"missing role":           {"endpointId": created.ID, "model": "qwen3"},
	} {
		raw := jsonrpcCall(t, h.conn, "roles.assign", params)
		if !strings.Contains(string(raw), "-32602") {
			t.Errorf("%s: roles.assign = %s, want -32602", name, raw)
		}
	}
	// Nothing was stored by any refusal.
	if roles := h.listRoles(t); roles[0].EndpointID != nil {
		t.Fatalf("refused assigns stored state: %+v", roles)
	}
}

// ── wire shape (contracts/README.md row 2 and 3) ────────────────────────

func TestRolesList_DTOConformsToContract(t *testing.T) {
	schema := loadSchema(t, "roles.list.schema.json")
	ep := "endpoint:custom:local:00000000000000000000000000000001"
	cases := map[string]rolesListResponse{
		"unassigned": {Roles: wireRoles(nil)},
		"assigned": {Roles: wireRoles([]profile.RoleAssignment{
			{Role: profile.RoleAnswering, EndpointID: ep, Model: "qwen3"},
		})},
		"all assigned": {Roles: wireRoles([]profile.RoleAssignment{
			{Role: profile.RoleAnswering, EndpointID: ep, Model: "qwen3"},
			{Role: profile.RoleClassifier, EndpointID: ep, Model: "gpt-4o-mini"},
		})},
	}
	for name, dto := range cases {
		t.Run(name, func(t *testing.T) {
			validateJSON(t, schema, mustMarshal(dto), "roles.list DTO ("+name+")")
		})
	}
}

// The real results off the real socket — the assertion that would have
// caught a handler sending something the DTO could not.
func TestRoles_OverTheWireConformsToContract(t *testing.T) {
	listSchema := loadSchema(t, "roles.list.schema.json")
	assignSchema := loadSchema(t, "roles.assign.schema.json")

	h := newEndpointHarness(t)
	h.setupAndUnseal()
	created := h.createEndpoint(t, endpointParams("Local", "http://127.0.0.1:11434/v1", "sk-test-123"))

	listRaw := jsonrpcCall(t, h.conn, "roles.list", nil)
	var listEnv struct {
		Error  *struct{ Code int } `json:"error"`
		Result json.RawMessage     `json:"result"`
	}
	if err := json.Unmarshal(listRaw, &listEnv); err != nil || listEnv.Error != nil {
		t.Fatalf("roles.list: %v\n%s", err, listRaw)
	}
	validateJSON(t, listSchema, listEnv.Result, "roles.list result (real socket)")

	assignRaw := jsonrpcCall(t, h.conn, "roles.assign", map[string]any{
		"role": "answering", "endpointId": created.ID, "model": "qwen3",
	})
	var assignEnv struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(assignRaw, &assignEnv); err != nil || assignEnv.Result == nil {
		t.Fatalf("roles.assign: %v\nraw: %s", err, assignRaw)
	}
	validateJSON(t, assignSchema, assignEnv.Result, "roles.assign result (real socket)")

	clearRaw := jsonrpcCall(t, h.conn, "roles.assign", map[string]any{"role": "answering"})
	var clearEnv struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(clearRaw, &clearEnv); err != nil {
		t.Fatalf("roles.assign (clear): %v", err)
	}
	validateJSON(t, assignSchema, clearEnv.Result, "roles.assign clear result (real socket)")
}
