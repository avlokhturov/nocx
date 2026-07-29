package transport

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
)

// TestGroupImpact_UpdateDefaultsChange asserts that changing group defaults
// returns the correct impact for affected profiles.
func TestGroupImpact_UpdateDefaultsChange(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Create a group with port 2222 and a profile that inherits it.
	defaults := &profile.ProfileDefaults{
		SparseSSHOptions: profile.SparseSSHOptions{
			Port: profile.Ptr(2222),
		},
	}
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g1", Name: "Prod", Defaults: defaults,
	})
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:p:0001", Name: "server-a", Type: "ssh", Group: "g1"},
		Options: profile.StoredSSHProfileOptions{Host: "host-a"},
	})

	// Propose changing port to 3333.
	resp := jsonrpcCall(t, conn, "groups.impact", map[string]any{
		"group": map[string]any{
			"id":       "g1",
			"name":     "Prod",
			"defaults": map[string]any{"port": 3333},
		},
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(result.Result.AffectedProfiles) != 1 {
		t.Fatalf("expected 1 affected profile, got %d", len(result.Result.AffectedProfiles))
	}
	pi := result.Result.AffectedProfiles[0]
	if pi.ProfileID != "ssh:p:0001" {
		t.Errorf("expected profile ssh:p:0001, got %s", pi.ProfileID)
	}

	// Should have a port diff.
	foundPort := false
	for _, d := range pi.Diffs {
		if d.Field == "port" {
			foundPort = true
			if !d.Dangerous {
				t.Error("port change should be dangerous (endpoint)")
			}
			break
		}
	}
	if !foundPort {
		t.Error("expected port diff, none found")
	}

	if !result.Result.Dangerous {
		t.Error("expected dangerous=true for endpoint change")
	}

	if result.Result.DeleteImpact != nil {
		t.Error("expected no deleteImpact for update")
	}
}

// TestGroupImpact_UpdateCosmeticOnly asserts that cosmetic-only changes
// (name, icon) produce no profile impact.
func TestGroupImpact_UpdateCosmeticOnly(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g1", Name: "Prod",
	})
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:p:0001", Name: "server-a", Type: "ssh", Group: "g1"},
		Options: profile.StoredSSHProfileOptions{Host: "host-a"},
	})

	// Propose changing name only — no effective-field change expected.
	resp := jsonrpcCall(t, conn, "groups.impact", map[string]any{
		"group": map[string]any{
			"id":   "g1",
			"name": "Renamed",
			"icon": "folder",
		},
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(result.Result.AffectedProfiles) != 0 {
		t.Errorf("expected 0 affected profiles for cosmetic change, got %d", len(result.Result.AffectedProfiles))
	}
	if result.Result.Dangerous {
		t.Error("expected dangerous=false for cosmetic change")
	}
}

// TestGroupImpact_UpdateDangerousField asserts that changing a dangerous field
// (credentialId) returns dangerous=true.
func TestGroupImpact_UpdateDangerousField(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Create a group with credentialId.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g1", Name: "Prod",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				CredentialID: profile.Ptr("cred:old:0001"),
			},
		},
	})
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:p:0001", Name: "server-a", Type: "ssh", Group: "g1"},
		Options: profile.StoredSSHProfileOptions{Host: "host-a"},
	})

	// Propose changing credentialId.
	resp := jsonrpcCall(t, conn, "groups.impact", map[string]any{
		"group": map[string]any{
			"id":   "g1",
			"name": "Prod",
			"defaults": map[string]any{
				"credentialId": "cred:new:0002",
			},
		},
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(result.Result.AffectedProfiles) != 1 {
		t.Fatalf("expected 1 affected profile, got %d", len(result.Result.AffectedProfiles))
	}

	foundCred := false
	for _, d := range result.Result.AffectedProfiles[0].Diffs {
		if d.Field == "credentialId" {
			foundCred = true
			if !d.Dangerous {
				t.Error("credentialId change should be dangerous")
			}
			break
		}
	}
	if !foundCred {
		t.Error("expected credentialId diff, none found")
	}

	if !result.Result.Dangerous {
		t.Error("expected dangerous=true")
	}
}

// TestGroupImpact_UpdateCycle asserts that a proposed cycle is rejected.
func TestGroupImpact_UpdateCycle(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// g2 -> g1
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g1", Name: "Root"})
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g2", Name: "Child", ParentGroupID: "g1"})

	// Propose making g1 -> g2 (cycle).
	resp := jsonrpcCall(t, conn, "groups.impact", map[string]any{
		"group": map[string]any{
			"id":            "g1",
			"name":          "Root",
			"parentGroupId": "g2",
		},
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if result.Result.DeleteImpact == nil || result.Result.DeleteImpact.Action != "refuse" {
		t.Errorf("expected refuse action for cycle, got %v", result.Result.DeleteImpact)
	}
}

// TestGroupImpact_DeletePromoteToRoot asserts that deleting a group with children
// shows promote-to-root impact.
func TestGroupImpact_DeletePromoteToRoot(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// g1 has child g2.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g1", Name: "Parent"})
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g2", Name: "Child", ParentGroupID: "g1"})
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:p:0001", Name: "server-a", Type: "ssh", Group: "g1"},
		Options: profile.StoredSSHProfileOptions{Host: "host-a"},
	})

	resp := jsonrpcCall(t, conn, "groups.impact", map[string]any{
		"deleteGroupId": "g1",
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if result.Result.DeleteImpact == nil {
		t.Fatal("expected deleteImpact")
	}
	if result.Result.DeleteImpact.Action != "promote_to_root" {
		t.Errorf("expected promote_to_root, got %s", result.Result.DeleteImpact.Action)
	}
	if len(result.Result.DeleteImpact.AffectedGroupIDs) != 1 || result.Result.DeleteImpact.AffectedGroupIDs[0] != "g2" {
		t.Errorf("expected affected group g2, got %v", result.Result.DeleteImpact.AffectedGroupIDs)
	}
}

// TestGroupUpdate_RejectsParentGroupIDChange asserts that groups.update
// blocks ParentGroupID changes.
func TestGroupUpdate_RejectsParentGroupIDChange(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g1", Name: "Root"})
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g2", Name: "Child", ParentGroupID: "g1"})

	// Try to change ParentGroupID via groups.update — should be rejected.
	resp := jsonrpcCall(t, conn, "groups.update", map[string]any{
		"id":            "g2",
		"name":          "Child",
		"parentGroupId": "",
	})

	var out struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Error == nil {
		t.Fatal("expected error for ParentGroupID change, got success")
	}
}

// TestGroupUpdate_RejectsDefaultsChange asserts that groups.update blocks
// Defaults changes.
func TestGroupUpdate_RejectsDefaultsChange(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g1", Name: "Root"})

	// Try to set defaults via groups.update — should be rejected.
	resp := jsonrpcCall(t, conn, "groups.update", map[string]any{
		"id":   "g1",
		"name": "Root",
		"defaults": map[string]any{
			"port": 2222,
		},
	})

	var out struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Error == nil {
		t.Fatal("expected error for Defaults change, got success")
	}
}

// TestGroupUpdate_AllowsCosmeticChange asserts that cosmetic-only changes
// (name) succeed through groups.update.
func TestGroupUpdate_AllowsCosmeticChange(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g1", Name: "Prod"})
	resp := jsonrpcCall(t, conn, "groups.update", profile.ProfileGroup{ID: "g1", Name: "Production"})

	var out struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Error != nil {
		t.Fatalf("unexpected error: %s", out.Error.Message)
	}
}

// TestGroupApply_ParentChange applies a group update with ParentGroupID change
// via groups.apply.
func TestGroupApply_ParentChange(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g1", Name: "Root"})
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g2", Name: "Orphan", ParentGroupID: "g1"})

	// Reparent g2 to root via groups.apply. Params is now an array (bulk).
	resp := jsonrpcCall(t, conn, "groups.apply", []any{
		map[string]any{
			"id":            "g2",
			"name":          "Orphan",
			"parentGroupId": "",
		},
	})

	var out struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Error != nil {
		t.Fatalf("unexpected error: %s", out.Error.Message)
	}

	// Verify via groups.list that g2 is now root.
	listResp := jsonrpcCall(t, conn, "groups.list", nil)
	var listResult struct {
		Result []profile.ProfileGroup `json:"result,omitempty"`
	}
	if err := json.Unmarshal(listResp, &listResult); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	for _, g := range listResult.Result {
		if g.ID == "g2" && g.ParentGroupID != "" {
			t.Fatalf("g2 ParentGroupID = %q, want empty after apply", g.ParentGroupID)
		}
	}
}

// TestGroupApply_BulkMultiple applies two group changes atomically via
// groups.apply. The old single-group handler could not validate two changes
// whose combined tree integrity depends on both being applied together.
func TestGroupApply_BulkMultiple(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g1", Name: "Root"})
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g2", Name: "Child", ParentGroupID: "g1"})
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g3", Name: "Grandchild", ParentGroupID: "g2"})

	// Reparent g2 to root AND reparent g3 under g1, atomically.
	resp := jsonrpcCall(t, conn, "groups.apply", []any{
		map[string]any{
			"id":   "g2",
			"name": "Child",
		},
		map[string]any{
			"id":            "g3",
			"name":          "Grandchild",
			"parentGroupId": "g1",
		},
	})

	var out struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Error != nil {
		t.Fatalf("unexpected error: %s", out.Error.Message)
	}

	// Verify the combined result.
	listResp := jsonrpcCall(t, conn, "groups.list", nil)
	var listResult struct {
		Result []profile.ProfileGroup `json:"result,omitempty"`
	}
	if err := json.Unmarshal(listResp, &listResult); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}

	for _, g := range listResult.Result {
		switch g.ID {
		case "g1":
			if g.ParentGroupID != "" {
				t.Errorf("g1 ParentGroupID = %q, want empty", g.ParentGroupID)
			}
		case "g2":
			if g.ParentGroupID != "" {
				t.Errorf("g2 ParentGroupID = %q, want empty", g.ParentGroupID)
			}
		case "g3":
			if g.ParentGroupID != "g1" {
				t.Errorf("g3 ParentGroupID = %q, want g1", g.ParentGroupID)
			}
		}
	}
}

// TestGroupApply_RejectsCycle asserts that groups.apply rejects a combined
// change that would create a cycle and leaves the store unchanged.
func TestGroupApply_RejectsCycle(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g1", Name: "Root"})
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g2", Name: "Child", ParentGroupID: "g1"})

	// Submit changes that together form a cycle: g1 -> g2, g2 -> g1.
	resp := jsonrpcCall(t, conn, "groups.apply", []any{
		map[string]any{
			"id":            "g1",
			"name":          "Root",
			"parentGroupId": "g2",
		},
		map[string]any{
			"id":            "g2",
			"name":          "Child",
			"parentGroupId": "g1",
		},
	})

	var out struct {
		Error *struct {
			Message string `json:"message,omitempty"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Error == nil {
		t.Fatal("expected error for cycle, got success")
	}

	// Store must be unchanged: g1 root, g2 child of g1.
	listResp := jsonrpcCall(t, conn, "groups.list", nil)
	var listResult struct {
		Result []profile.ProfileGroup `json:"result,omitempty"`
	}
	if err := json.Unmarshal(listResp, &listResult); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	for _, g := range listResult.Result {
		switch g.ID {
		case "g1":
			if g.ParentGroupID != "" {
				t.Errorf("g1 ParentGroupID = %q after rejected cycle, want empty", g.ParentGroupID)
			}
		case "g2":
			if g.ParentGroupID != "g1" {
				t.Errorf("g2 ParentGroupID = %q after rejected cycle, want g1", g.ParentGroupID)
			}
		}
	}
}

// TestGroupDelete_PromotesChildren asserts that deleting a group promotes
// its children to root.
func TestGroupDelete_PromotesChildren(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g1", Name: "Parent"})
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{ID: "g2", Name: "Child", ParentGroupID: "g1"})

	// Delete g1.
	jsonrpcCall(t, conn, "groups.delete", map[string]any{"id": "g1"})

	// g2 should now be a root group (no parent).
	resp := jsonrpcCall(t, conn, "groups.list", map[string]any{})
	var list struct {
		Result []profile.ProfileGroup `json:"result"`
	}
	if err := json.Unmarshal(resp, &list); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	var child *profile.ProfileGroup
	for i := range list.Result {
		if list.Result[i].ID == "g2" {
			child = &list.Result[i]
			break
		}
	}
	if child == nil {
		t.Fatal("child group g2 not found")
	}
	if child.ParentGroupID != "" {
		t.Errorf("expected child to be promoted to root (no parent), got parentGroupId=%s", child.ParentGroupID)
	}
}

// TestGroupImpact_UpdateParentChange asserts that changing a group's
// parent correctly shows profile impact.
func TestGroupImpact_UpdateParentChange(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Group tree: g-root (port 2222) → g-child (no port) → profile
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g-root", Name: "Root",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port: profile.Ptr(2222),
			},
		},
	})
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g-child", Name: "Child", ParentGroupID: "g-root",
	})
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:p:0001", Name: "server-a", Type: "ssh", Group: "g-child"},
		Options: profile.StoredSSHProfileOptions{Host: "host-a"},
	})

	// Create alternative group with a different port.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g-other", Name: "Other",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port: profile.Ptr(4444),
			},
		},
	})

	// Propose reparenting g-child to g-other.
	resp := jsonrpcCall(t, conn, "groups.impact", map[string]any{
		"group": map[string]any{
			"id":            "g-child",
			"name":          "Child",
			"parentGroupId": "g-other",
		},
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(result.Result.AffectedProfiles) != 1 {
		t.Fatalf("expected 1 affected profile for parent change, got %d", len(result.Result.AffectedProfiles))
	}

	foundPort := false
	for _, d := range result.Result.AffectedProfiles[0].Diffs {
		if d.Field == "port" {
			foundPort = true
			break
		}
	}
	if !foundPort {
		t.Error("expected port diff after reparenting to group with different port")
	}

	if !result.Result.Dangerous {
		t.Error("expected dangerous=true for port change")
	}
}

// TestGroupImpact_InvalidParams asserts that invalid request params return errors.
func TestGroupImpact_InvalidParams(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Both group and deleteGroupId set.
	resp := jsonrpcCall(t, conn, "groups.impact", map[string]any{
		"group":         map[string]any{"id": "g1", "name": "test"},
		"deleteGroupId": "g1",
	})
	var out struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Error == nil {
		t.Fatal("expected error for both params set")
	}

	// Neither set.
	resp = jsonrpcCall(t, conn, "groups.impact", map[string]any{})
	out = struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}{}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Error == nil {
		t.Fatal("expected error for empty params")
	}

	// Group with no ID.
	resp = jsonrpcCall(t, conn, "groups.impact", map[string]any{
		"group": map[string]any{"name": "test"},
	})
	out = struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}{}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Error == nil {
		t.Fatal("expected error for group without id")
	}
}

// TestGroupImpact_DeleteUnknownGroup asserts that deleting an unknown group
// returns refuse with a reason.
func TestGroupImpact_DeleteUnknownGroup(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	resp := jsonrpcCall(t, conn, "groups.impact", map[string]any{
		"deleteGroupId": "nonexistent",
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if result.Result.DeleteImpact == nil || result.Result.DeleteImpact.Action != "refuse" {
		t.Errorf("expected refuse action for unknown group, got %v", result.Result.DeleteImpact)
	}
}

// ---------------------------------------------------------------------------
// profiles.moveImpact tests
// ---------------------------------------------------------------------------

// TestProfileMoveImpact_DefaultsChange asserts that moving a profile into a
// group whose defaults differ reports those fields as changed, with dangerous
// ones marked.
func TestProfileMoveImpact_DefaultsChange(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Create default group with port 2222.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g-source", Name: "Source",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port: profile.Ptr(2222),
			},
		},
	})
	// Create target group with a different port.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g-target", Name: "Target",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port: profile.Ptr(3333),
			},
		},
	})
	// Create profile in source group.
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:p:0001", Name: "server-a", Type: "ssh", Group: "g-source"},
		Options: profile.StoredSSHProfileOptions{Host: "host-a"},
	})

	// Propose moving to g-target.
	resp := jsonrpcCall(t, conn, "profiles.moveImpact", map[string]any{
		"profileIds":    []string{"ssh:p:0001"},
		"targetGroupId": "g-target",
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(result.Result.AffectedProfiles) != 1 {
		t.Fatalf("expected 1 affected profile, got %d", len(result.Result.AffectedProfiles))
	}
	pi := result.Result.AffectedProfiles[0]
	if pi.ProfileID != "ssh:p:0001" {
		t.Errorf("expected profile ssh:p:0001, got %s", pi.ProfileID)
	}

	foundPort := false
	for _, d := range pi.Diffs {
		if d.Field == "port" {
			foundPort = true
			if !d.Dangerous {
				t.Error("port change should be dangerous")
			}
			break
		}
	}
	if !foundPort {
		t.Error("expected port diff, none found")
	}

	if !result.Result.Dangerous {
		t.Error("expected dangerous=true for port change")
	}
}

// TestProfileMoveImpact_IdenticalDefaults asserts that moving a profile into a
// group whose defaults are identical reports no change.
func TestProfileMoveImpact_IdenticalDefaults(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Two groups with identical port defaults.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g-source", Name: "Source",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port: profile.Ptr(2222),
			},
		},
	})
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g-target", Name: "Target",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port: profile.Ptr(2222),
			},
		},
	})
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:p:0001", Name: "server-a", Type: "ssh", Group: "g-source"},
		Options: profile.StoredSSHProfileOptions{Host: "host-a"},
	})

	resp := jsonrpcCall(t, conn, "profiles.moveImpact", map[string]any{
		"profileIds":    []string{"ssh:p:0001"},
		"targetGroupId": "g-target",
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(result.Result.AffectedProfiles) != 0 {
		t.Errorf("expected 0 affected profiles for identical defaults, got %d", len(result.Result.AffectedProfiles))
	}

	if result.Result.Dangerous {
		t.Error("expected dangerous=false for identical defaults")
	}
}

// TestProfileMoveImpact_OwnValueOverrides asserts that a profile with its own
// port set does not report a change when moved to a group with a different
// default, because the profile's own value wins at higher precedence.
func TestProfileMoveImpact_OwnValueOverrides(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Source group: port 2222.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g-source", Name: "Source",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port: profile.Ptr(2222),
			},
		},
	})
	// Target group: port 3333.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g-target", Name: "Target",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port: profile.Ptr(3333),
			},
		},
	})
	// Profile has its own port of 4444 — this overrides any group default.
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base: profile.Base{ID: "ssh:p:0001", Name: "server-a", Type: "ssh", Group: "g-source"},
		Options: profile.StoredSSHProfileOptions{
			Host: "host-a",
			Port: profile.Ptr(4444),
		},
	})

	resp := jsonrpcCall(t, conn, "profiles.moveImpact", map[string]any{
		"profileIds":    []string{"ssh:p:0001"},
		"targetGroupId": "g-target",
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(result.Result.AffectedProfiles) != 0 {
		t.Errorf("expected 0 affected profiles when own value overrides, got %d", len(result.Result.AffectedProfiles))
	}

	if result.Result.Dangerous {
		t.Error("expected dangerous=false when own value overrides")
	}
}

// TestProfileMoveImpact_PromotionToRoot asserts that moving a profile from a
// group to root shows the effective-field diff between group defaults and
// hardcoded defaults.
func TestProfileMoveImpact_PromotionToRoot(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Create group with port 2222 and a profile that inherits it.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g1", Name: "Prod",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port: profile.Ptr(2222),
			},
		},
	})
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:p:0001", Name: "server-a", Type: "ssh", Group: "g1"},
		Options: profile.StoredSSHProfileOptions{Host: "host-a"},
	})

	// Propose promoting to root (empty targetGroupId).
	resp := jsonrpcCall(t, conn, "profiles.moveImpact", map[string]any{
		"profileIds":    []string{"ssh:p:0001"},
		"targetGroupId": "",
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(result.Result.AffectedProfiles) != 1 {
		t.Fatalf("expected 1 affected profile for promotion, got %d", len(result.Result.AffectedProfiles))
	}

	foundPort := false
	for _, d := range result.Result.AffectedProfiles[0].Diffs {
		if d.Field == "port" {
			foundPort = true
			break
		}
	}
	if !foundPort {
		t.Error("expected port diff after promotion to root (group → hardcoded)")
	}

	if !result.Result.Dangerous {
		t.Error("expected dangerous=true for port change on promotion")
	}
}

// TestProfileMoveImpact_MultipleProfiles asserts that several profiles can be
// evaluated in a single call.
func TestProfileMoveImpact_MultipleProfiles(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Source group: port 2222.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g-source", Name: "Source",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port: profile.Ptr(2222),
			},
		},
	})
	// Target group: port 3333.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g-target", Name: "Target",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port: profile.Ptr(3333),
			},
		},
	})
	// Two profiles in source group.
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:p:0001", Name: "server-a", Type: "ssh", Group: "g-source"},
		Options: profile.StoredSSHProfileOptions{Host: "host-a"},
	})
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:p:0002", Name: "server-b", Type: "ssh", Group: "g-source"},
		Options: profile.StoredSSHProfileOptions{Host: "host-b"},
	})

	resp := jsonrpcCall(t, conn, "profiles.moveImpact", map[string]any{
		"profileIds":    []string{"ssh:p:0001", "ssh:p:0002"},
		"targetGroupId": "g-target",
	})

	var result struct {
		Result groupImpactResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(result.Result.AffectedProfiles) != 2 {
		t.Fatalf("expected 2 affected profiles, got %d", len(result.Result.AffectedProfiles))
	}

	// Both profiles should have port diffs.
	for _, pi := range result.Result.AffectedProfiles {
		foundPort := false
		for _, d := range pi.Diffs {
			if d.Field == "port" {
				foundPort = true
				break
			}
		}
		if !foundPort {
			t.Errorf("profile %s: expected port diff", pi.ProfileID)
		}
	}

	if !result.Result.Dangerous {
		t.Error("expected dangerous=true for port changes")
	}
}

// TestProfileMoveImpact_InvalidParams asserts that invalid request params
// return errors.
func TestProfileMoveImpact_InvalidParams(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Empty profileIds.
	resp := jsonrpcCall(t, conn, "profiles.moveImpact", map[string]any{
		"profileIds":    []string{},
		"targetGroupId": "g-target",
	})

	var result struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Error == nil {
		t.Fatal("expected error for empty profileIds, got success")
	}
}
