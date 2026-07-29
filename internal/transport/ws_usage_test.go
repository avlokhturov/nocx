package transport

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
)

func TestCredentialUsageRPC_EmptyStore(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := t.Context()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })

	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })

	resp := jsonrpcCall(t, conn, "credentials.usage", map[string]any{})
	var result struct {
		Result struct {
			Usage []profile.CredentialUsage `json:"usage"`
		} `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(result.Result.Usage) != 0 {
		t.Errorf("expected empty usage list, got %d items", len(result.Result.Usage))
	}
}

func TestCredentialUsageRPC_DirectAndGroupInheritance(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := t.Context()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })

	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })

	// Create credentials directly through the store for test setup.
	c1 := profile.Credential{ID: "cred:direct:1", Name: "Direct", Username: "alice"}
	c2 := profile.Credential{ID: "cred:group:1", Name: "GroupInherit", Username: "bob"}
	c3 := profile.Credential{ID: "cred:orphan:1", Name: "Orphan", Username: "ghost"}

	if err := ps.CreateCredential(c1); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}
	if err := ps.CreateCredential(c2); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}
	if err := ps.CreateCredential(c3); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	// Create a group with a credential default.
	g1 := profile.ProfileGroup{
		ID:   "g1",
		Name: "Prod",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				CredentialID: credPtr("cred:group:1"),
			},
		},
	}
	if err := ps.CreateGroup(g1); err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	// Create profiles:
	// p1 — directly names cred:direct:1
	// p2 — inherits cred:group:1 from g1
	p1 := profile.SSHProfile{
		Base: profile.Base{ID: "ssh:p1:1", Type: "ssh", Name: "web-direct"},
		Options: profile.SSHProfileOptions{
			Host:         "web.example.com",
			CredentialID: "cred:direct:1",
		},
	}
	if err := ps.CreateProfile(p1); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}
	p2 := profile.SSHProfile{
		Base: profile.Base{ID: "ssh:p2:1", Type: "ssh", Name: "web-inherit", Group: "g1"},
		Options: profile.SSHProfileOptions{
			Host: "web2.example.com",
			// No credentialId — inherits from group
		},
	}
	if err := ps.CreateProfile(p2); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}

	// Call credentials.usage
	resp := jsonrpcCall(t, conn, "credentials.usage", map[string]any{})
	var raw struct {
		Result struct {
			Usage []profile.CredentialUsage `json:"usage"`
		} `json:"result"`
	}
	if err := json.Unmarshal(resp, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	usage := raw.Result.Usage
	usageByID := make(map[string]profile.CredentialUsage)
	for _, u := range usage {
		usageByID[u.CredentialID] = u
	}

	// cred:direct:1 — should have p1 with source="profile"
	direct, ok := usageByID["cred:direct:1"]
	if !ok {
		t.Fatal("cred:direct:1 not in usage")
	}
	if len(direct.Profiles) != 1 {
		t.Fatalf("cred:direct:1: expected 1 profile, got %d", len(direct.Profiles))
	}
	if direct.Profiles[0].ProfileID != "ssh:p1:1" {
		t.Errorf("cred:direct:1: expected profile ssh:p1:1, got %s", direct.Profiles[0].ProfileID)
	}
	if direct.Profiles[0].Source != "profile" {
		t.Errorf("cred:direct:1: expected source=profile, got %s", direct.Profiles[0].Source)
	}

	// cred:group:1 — should have p2 with source="group", groupId="g1"
	groupCred, ok := usageByID["cred:group:1"]
	if !ok {
		t.Fatal("cred:group:1 not in usage")
	}
	if len(groupCred.Profiles) != 1 {
		t.Fatalf("cred:group:1: expected 1 profile, got %d", len(groupCred.Profiles))
	}
	ref := groupCred.Profiles[0]
	if ref.ProfileID != "ssh:p2:1" {
		t.Errorf("cred:group:1: expected profile ssh:p2:1, got %s", ref.ProfileID)
	}
	if ref.Source != "group" {
		t.Errorf("cred:group:1: expected source=group, got %s", ref.Source)
	}
	if ref.GroupID != "g1" {
		t.Errorf("cred:group:1: expected groupId=g1, got %s", ref.GroupID)
	}
	if ref.GroupName != "Prod" {
		t.Errorf("cred:group:1: expected groupName=Prod, got %s", ref.GroupName)
	}

	// cred:orphan:1 — must be present with empty profiles
	orphan, ok := usageByID["cred:orphan:1"]
	if !ok {
		t.Fatal("cred:orphan:1 not in usage (must appear even when unused)")
	}
	if len(orphan.Profiles) != 0 {
		t.Errorf("cred:orphan:1: expected empty profiles, got %d", len(orphan.Profiles))
	}
}

func TestCredentialUsageRPC_MethodNotFoundWhenNotWired(t *testing.T) {
	// Without profile/group/credential stores, credentials.usage should return error.
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)))
	ctx := t.Context()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })

	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })

	resp := jsonrpcCall(t, conn, "credentials.usage", map[string]any{})
	var check struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &check); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if check.Error == nil {
		t.Fatal("expected error for unwired credentials.usage")
	}
	if check.Error.Code != -32601 {
		t.Errorf("error code = %d, want -32601", check.Error.Code)
	}
}

// credPtr returns a pointer to the given string, for use in SparseSSHOptions.
func credPtr(s string) *string {
	return &s
}
