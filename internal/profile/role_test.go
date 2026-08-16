package profile

// The role layer (bead nocx-e6kn2): the closed role enum, the assignment
// store, and THE ONE resolver. The tests pin the product rules the bead
// names — a role with no assignment is a refusal, never a fallback; a
// deleted endpoint or removed model leaves the role unresolvable and says
// so, never resolving to a neighbour.

import (
	"errors"
	"strings"
	"testing"
)

func TestAllRoles_IsTheClosedSetInOrder(t *testing.T) {
	got := AllRoles()
	want := []ModelRole{RoleAnswering, RoleClassifier}
	if len(got) != len(want) {
		t.Fatalf("AllRoles() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("AllRoles()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestParseModelRole(t *testing.T) {
	if r, err := ParseModelRole("answering"); err != nil || r != RoleAnswering {
		t.Fatalf("ParseModelRole(answering) = %q, %v", r, err)
	}
	if r, err := ParseModelRole("classifier"); err != nil || r != RoleClassifier {
		t.Fatalf("ParseModelRole(classifier) = %q, %v", r, err)
	}
	if _, err := ParseModelRole("gpt-4o"); !errors.Is(err, ErrRoleUnknown) {
		t.Fatalf("ParseModelRole(gpt-4o) = %v, want ErrRoleUnknown", err)
	}
}

func TestAssignRole_UpsertsOneAssignmentPerRole(t *testing.T) {
	s := newTestStore(t)
	first := RoleAssignment{Role: RoleAnswering, EndpointID: "endpoint:custom:a:1", Model: "gpt-4o"}
	if err := s.AssignRole(first); err != nil {
		t.Fatalf("AssignRole: %v", err)
	}
	second := RoleAssignment{Role: RoleAnswering, EndpointID: "endpoint:custom:b:2", Model: "qwen3"}
	if err := s.AssignRole(second); err != nil {
		t.Fatalf("AssignRole (replace): %v", err)
	}
	got, err := s.LoadRoleAssignments()
	if err != nil {
		t.Fatalf("LoadRoleAssignments: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("assignments = %+v, want exactly one row for the role", got)
	}
	if got[0].Model != "qwen3" || got[0].EndpointID != "endpoint:custom:b:2" {
		t.Errorf("assignment = %+v, want the SECOND assignment to have replaced the first", got[0])
	}
}

func TestAssignRole_RefusesUnknownRoleAndEmptyPair(t *testing.T) {
	s := newTestStore(t)
	for _, tc := range []RoleAssignment{
		{Role: "invented", EndpointID: "e", Model: "m"},
		{Role: RoleAnswering, EndpointID: "", Model: "m"},
		{Role: RoleAnswering, EndpointID: "e", Model: ""},
	} {
		if err := s.AssignRole(tc); err == nil {
			t.Errorf("AssignRole(%+v) succeeded, want a refusal", tc)
		}
	}
	if got, _ := s.LoadRoleAssignments(); len(got) != 0 {
		t.Fatalf("refused assignments must not be stored, got %+v", got)
	}
}

func validRoleEndpoints() []Endpoint {
	return []Endpoint{
		{
			ID:      "endpoint:custom:openai:111",
			Name:    "OpenAI",
			BaseURL: "https://api.openai.com/v1",
			Schema:  EndpointSchemaOpenAICompatible,
			Models:  []EndpointModel{{Name: "gpt-4o"}, {Name: "gpt-4o-mini"}},
		},
		{
			ID:      "endpoint:custom:local:222",
			Name:    "Local",
			BaseURL: "http://127.0.0.1:11434/v1",
			Schema:  EndpointSchemaOpenAICompatible,
			Models:  []EndpointModel{{Name: "qwen3"}},
		},
	}
}

func TestAssignRole_ClearRemovesTheAssignment(t *testing.T) {
	s := newTestStore(t)
	if err := s.AssignRole(RoleAssignment{Role: RoleAnswering, EndpointID: "endpoint:custom:a:1", Model: "gpt-4o"}); err != nil {
		t.Fatalf("AssignRole: %v", err)
	}
	// The empty pair is the CLEAR write: the role returns to the visible
	// "no model assigned" state and resolution refuses again.
	if err := s.AssignRole(RoleAssignment{Role: RoleAnswering}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if got, _ := s.LoadRoleAssignments(); len(got) != 0 {
		t.Fatalf("assignments after clear = %+v, want none", got)
	}
	// Clearing an already-clear role succeeds without storing anything.
	if err := s.AssignRole(RoleAssignment{Role: RoleAnswering}); err != nil {
		t.Fatalf("clear of a clear role: %v", err)
	}
	// A HALF-clear (one field set) is still refused: a role is assigned to
	// an (endpoint, model) pair or to nothing.
	if err := s.AssignRole(RoleAssignment{Role: RoleAnswering, Model: "gpt-4o"}); err == nil {
		t.Fatal("half-clear assignment succeeded, want a refusal")
	}
}

func TestResolveRole_ReturnsTheAssignedPair(t *testing.T) {
	eps := validRoleEndpoints()
	assignments := []RoleAssignment{
		{Role: RoleAnswering, EndpointID: "endpoint:custom:local:222", Model: "qwen3"},
	}
	ep, model, err := ResolveRole(RoleAnswering, assignments, eps)
	if err != nil {
		t.Fatalf("ResolveRole: %v", err)
	}
	if model != "qwen3" {
		t.Errorf("model = %q, want qwen3", model)
	}
	if ep.ID != "endpoint:custom:local:222" {
		t.Errorf("endpoint = %s, want the assigned one", ep.ID)
	}
}

// The product rule (bead acceptance 2): a role with no model assigned is a
// visible refusal, never a silent fallback to another model — even when an
// unassigned endpoint with models exists right there.
func TestResolveRole_UnassignedIsARefusalNeverAFallback(t *testing.T) {
	_, _, err := ResolveRole(RoleAnswering, nil, validRoleEndpoints())
	if !errors.Is(err, ErrRoleUnassigned) {
		t.Fatalf("ResolveRole without an assignment = %v, want ErrRoleUnassigned", err)
	}
	if !strings.Contains(err.Error(), string(RoleAnswering)) {
		t.Errorf("refusal %q must name the role", err)
	}
}

// Bead acceptance criterion 3: a deleted endpoint or removed model leaves
// the role unresolvable and SAYS so — never a hop to a neighbour.
func TestResolveRole_DeletedEndpointIsARefusalThatNamesIt(t *testing.T) {
	assignments := []RoleAssignment{
		{Role: RoleAnswering, EndpointID: "endpoint:custom:openai:111", Model: "gpt-4o"},
	}
	// The assigned endpoint is gone from the store; another endpoint remains.
	_, _, err := ResolveRole(RoleAnswering, assignments, validRoleEndpoints()[1:])
	if !errors.Is(err, ErrRoleEndpointGone) {
		t.Fatalf("ResolveRole with a deleted endpoint = %v, want ErrRoleEndpointGone", err)
	}
	if !strings.Contains(err.Error(), "endpoint:custom:openai:111") {
		t.Errorf("error %q must name the deleted endpoint", err)
	}
}

func TestResolveRole_RemovedModelIsARefusalThatNamesIt(t *testing.T) {
	assignments := []RoleAssignment{
		{Role: RoleAnswering, EndpointID: "endpoint:custom:openai:111", Model: "gpt-4o"},
	}
	eps := []Endpoint{{
		ID:      "endpoint:custom:openai:111",
		Name:    "OpenAI",
		BaseURL: "https://api.openai.com/v1",
		Schema:  EndpointSchemaOpenAICompatible,
		// gpt-4o removed by an update; another model remains, which must NOT
		// be silently substituted.
		Models: []EndpointModel{{Name: "gpt-4o-mini"}},
	}}
	_, _, err := ResolveRole(RoleAnswering, assignments, eps)
	if !errors.Is(err, ErrRoleModelGone) {
		t.Fatalf("ResolveRole with a removed model = %v, want ErrRoleModelGone", err)
	}
	if !strings.Contains(err.Error(), "gpt-4o") {
		t.Errorf("error %q must name the removed model", err)
	}
}

func TestResolveRole_UnknownRoleIsARefusal(t *testing.T) {
	_, _, err := ResolveRole("invented", nil, nil)
	if !errors.Is(err, ErrRoleUnknown) {
		t.Fatalf("ResolveRole(invented) = %v, want ErrRoleUnknown", err)
	}
}

// The store keeps a dangling assignment (the delete clears SECRET
// references, never a role's endpoint name), so the row can show "no longer
// available" and the resolver's refusal can name what disappeared.
func TestAssignRole_DoesNotRequireTheEndpointToExist(t *testing.T) {
	s := newTestStore(t)
	if err := s.AssignRole(RoleAssignment{Role: RoleClassifier, EndpointID: "endpoint:custom:ghost:1", Model: "gpt-4o"}); err != nil {
		t.Fatalf("AssignRole to a not-yet-existing endpoint must succeed (shape is the write's check): %v", err)
	}
	got, err := s.LoadRoleAssignments()
	if err != nil || len(got) != 1 || got[0].EndpointID != "endpoint:custom:ghost:1" {
		t.Fatalf("assignments = %+v (err %v), want the dangling assignment stored", got, err)
	}
}

func TestRoleRepository_SurvivesReload(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/p.json"
	s := NewJSONStore(path)
	if err := s.AssignRole(RoleAssignment{Role: RoleClassifier, EndpointID: "e", Model: "m"}); err != nil {
		t.Fatalf("AssignRole: %v", err)
	}
	again := NewJSONStore(path)
	got, err := again.LoadRoleAssignments()
	if err != nil || len(got) != 1 || got[0].Role != RoleClassifier {
		t.Fatalf("reloaded assignments = %+v (err %v), want the stored row", got, err)
	}
}
