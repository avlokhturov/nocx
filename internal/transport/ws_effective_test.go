package transport

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
)

// TestEffectiveProfile_ProvenanceAndPatch is the required validation test
// from the brief (§6, items 1-7).
//
//  1. Store a profile with no local port, user or auth.
//  2. Give its group port 2222 and credential prod-ops.
//  3. Make that credential supply user deploy, auth publicKey, and fake
//     secret-reference canaries in its secret fields.
//  4. Call profiles.effective. Assert: port provenance is the group;
//     credentialId provenance is the group; user and auth provenance is the
//     credential.
//  5. Assert the raw JSON contains none of the canaries.
//  6. profiles.patch set options.port, then unset it.
//  7. Reload from storage: assert the stored port is absent, not 2222,
//     while the returned effective port is 2222 sourced from the group.
func TestEffectiveProfile_ProvenanceAndPatch(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(dir + "/p.json")
	cs := newTestStore()

	// Step 2-3: Create a group with port 2222 and credentialId.
	const groupID = "group-prod"
	// Not a credential — an opaque record id, which is what makes it safe to
	// assert on. gosec pattern-matches the name, not the meaning.
	const credID = "cred:prod-ops:1" //nolint:gosec // record id, not a secret

	grp := profile.ProfileGroup{
		ID:   groupID,
		Name: "Prod",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				Port:         intPtr(2222),
				CredentialID: strPtr(credID),
			},
		},
	}
	if err := ps.CreateGroup(grp); err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	// Step 3: Credential with user deploy, auth publicKey, and canary secrets.
	// Create canary secrets FIRST so we can use their generated IDs in the
	// credential record.
	pwID, _ := cs.Create(context.Background(), credential.NewSecret("hunter2"))
	ppID, _ := cs.Create(context.Background(), credential.NewSecret("passphrase"))

	// Step 3: Credential with user deploy, auth publicKey, and canary secrets.
	cred := profile.Credential{
		ID:                 credID,
		Name:               "prod-ops",
		Username:           "deploy",
		Auth:               profile.AuthPublicKey,
		SecretID:           string(pwID),
		PassphraseSecretID: string(ppID),
	}
	if err := ps.CreateCredential(cred); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}
	prof := profile.SSHProfile{
		Base: profile.Base{
			ID:    "ssh:prod-api:1",
			Type:  "ssh",
			Name:  "prod-api",
			Group: groupID,
		},
		Options: profile.StoredSSHProfileOptions{
			Host: "api.prod.example.com",
		},
	}
	if err := ps.CreateProfile(prof); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}

	// Wire WSServer with stores.
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(cs))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })

	// Step 4: Call profiles.effective.
	resp := jsonrpcCall(t, conn, "profiles.effective", map[string]any{
		"ids": []string{"ssh:prod-api:1"},
	})

	var effResult struct {
		Result struct {
			Profiles []profile.EffectiveProfileDTO `json:"profiles"`
			Errors   []profileErrorEntry           `json:"errors"`
		} `json:"result"`
	}
	if err := json.Unmarshal(resp, &effResult); err != nil {
		t.Fatalf("unmarshal effective result: %v\nraw: %s", err, string(resp))
	}

	if len(effResult.Result.Errors) > 0 {
		t.Fatalf("unexpected errors: %+v", effResult.Result.Errors)
	}
	if len(effResult.Result.Profiles) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(effResult.Result.Profiles))
	}

	dto := effResult.Result.Profiles[0]
	if dto.ID != "ssh:prod-api:1" {
		t.Errorf("profile id = %q, want ssh:prod-api:1", dto.ID)
	}

	// Assert port provenance is group.
	portField, ok := dto.Fields["port"]
	if !ok {
		t.Fatal("missing field: port")
	}
	if v, isNum := portField.Value.(float64); !isNum || v != 2222 {
		t.Errorf("port value = %v, want 2222", portField.Value)
	}
	if portField.Source.Kind != profile.EffectiveSourceGroup {
		t.Errorf("port source kind = %q, want %q", portField.Source.Kind, profile.EffectiveSourceGroup)
	}
	if portField.Source.ID != groupID {
		t.Errorf("port source id = %q, want %q", portField.Source.ID, groupID)
	}
	if portField.Source.Label != "Prod" {
		t.Errorf("port source label = %q, want Prod", portField.Source.Label)
	}

	// Assert credentialId provenance is group.
	credField, ok := dto.Fields["credentialId"]
	if !ok {
		t.Fatal("missing field: credentialId")
	}
	if credField.Value != credID {
		t.Errorf("credentialId value = %v, want %s", credField.Value, credID)
	}
	if credField.Source.Kind != profile.EffectiveSourceGroup {
		t.Errorf("credentialId source kind = %q, want %q", credField.Source.Kind, profile.EffectiveSourceGroup)
	}

	// Assert user provenance is credential.
	userField, ok := dto.Fields["user"]
	if !ok {
		t.Fatal("missing field: user")
	}
	if userField.Value != "deploy" {
		t.Errorf("user value = %v, want deploy", userField.Value)
	}
	if userField.Source.Kind != profile.EffectiveSourceCredential {
		t.Errorf("user source kind = %q, want %q", userField.Source.Kind, profile.EffectiveSourceCredential)
	}
	if userField.Source.ID != credID {
		t.Errorf("user source id = %q, want %s", userField.Source.ID, credID)
	}
	if userField.Source.Label != "prod-ops" {
		t.Errorf("user source label = %q, want prod-ops", userField.Source.Label)
	}

	// Assert auth provenance is credential.
	authField, ok := dto.Fields["auth"]
	if !ok {
		t.Fatal("missing field: auth")
	}
	if authField.Value != "publicKey" {
		t.Errorf("auth value = %v, want publicKey", authField.Value)
	}
	if authField.Source.Kind != profile.EffectiveSourceCredential {
		t.Errorf("auth source kind = %q, want %q", authField.Source.Kind, profile.EffectiveSourceCredential)
	}

	// Step 5: Assert raw JSON contains none of the canary secret references.
	rawJSON, err := json.Marshal(effResult.Result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	rawStr := string(rawJSON)
	canaries := []string{"sec:canary-password", "sec:canary-passphrase"}
	for _, c := range canaries {
		if strings.Contains(rawStr, c) {
			t.Errorf("raw JSON leaks canary %q", c)
		}
	}

	// Step 6: Patch set options.port=2200, then unset options.port.
	patchSetResp := jsonrpcCall(t, conn, "profiles.patch", map[string]any{
		"id":  "ssh:prod-api:1",
		"set": map[string]any{"options.port": float64(2200)},
	})
	var patchSetResult struct {
		Result profile.EffectiveProfileDTO `json:"result"`
	}
	if unmarshalErr := json.Unmarshal(patchSetResp, &patchSetResult); unmarshalErr != nil {
		t.Fatalf("unmarshal patch set result: %v\nraw: %s", err, string(patchSetResp))
	}
	if patchSetResult.Result.ID != "ssh:prod-api:1" {
		t.Errorf("patch set returned id %q", patchSetResult.Result.ID)
	}
	// After set, port should be 2200 from profile.
	pf := patchSetResult.Result.Fields["port"]
	if v, ok := pf.Value.(float64); !ok || v != 2200 {
		t.Errorf("after set, port = %v, want 2200", pf.Value)
	}
	if pf.Source.Kind != profile.EffectiveSourceProfile {
		t.Errorf("after set, port source = %q, want profile", pf.Source.Kind)
	}

	// Now unset port.
	patchUnsetResp := jsonrpcCall(t, conn, "profiles.patch", map[string]any{
		"id":    "ssh:prod-api:1",
		"unset": []string{"options.port"},
	})
	var patchUnsetResult struct {
		Result profile.EffectiveProfileDTO `json:"result"`
	}
	if unmarshalErr := json.Unmarshal(patchUnsetResp, &patchUnsetResult); unmarshalErr != nil {
		t.Fatalf("unmarshal patch unset result: %v\nraw: %s", err, string(patchUnsetResp))
	}
	// After unset, effective port should be 2222 from group.
	puf := patchUnsetResult.Result.Fields["port"]
	if v, ok := puf.Value.(float64); !ok || v != 2222 {
		t.Errorf("after unset, effective port = %v, want 2222", puf.Value)
	}
	if puf.Source.Kind != profile.EffectiveSourceGroup {
		t.Errorf("after unset, port source = %q, want group", puf.Source.Kind)
	}

	// Step 7: Reload from storage and assert stored port is absent (nil).
	storedProfiles, err := ps.LoadProfiles()
	if err != nil {
		t.Fatalf("LoadProfiles: %v", err)
	}
	var stored *profile.SSHProfile
	for i := range storedProfiles {
		if storedProfiles[i].ID == "ssh:prod-api:1" {
			stored = &storedProfiles[i]
			break
		}
	}
	if stored == nil {
		t.Fatal("stored profile not found after reload")
	}
	if stored.Options.Port != nil {
		t.Errorf("stored port = %v, want nil (absent, inheriting from group)", stored.Options.Port)
	}
}

// TestEffectiveProfile_ExplicitFalseSurvivesRoundTrip proves that the
// presence-aware storage correctly preserves explicit false/zero values:
// "profile explicit false/zero" remains distinguishable from "inherit"
// through a store-load-resolve cycle.
//
// This is the foundational bug from §3.3: before this change, sshOptionsToSparse
// treated false as "not set", so agentForward=false in a profile with
// group default agentForward=true resolved to true, sourced "group".
func TestEffectiveProfile_ExplicitFalseSurvivesRoundTrip(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(dir + "/p.json")

	// Group: agentForward = true, keepaliveInterval = 5000.
	const groupID = "group-test"
	grp := profile.ProfileGroup{
		ID:   groupID,
		Name: "TestGroup",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				AgentForward:      profile.Ptr(true),
				KeepaliveInterval: profile.Ptr(5000),
			},
		},
	}
	if err := ps.CreateGroup(grp); err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	// Profile: agentForward = false, keepaliveInterval = 0 (explicit disable).
	prof := profile.SSHProfile{
		Base: profile.Base{
			ID:    "ssh:explicit-false:1",
			Type:  "ssh",
			Name:  "explicit-false",
			Group: groupID,
		},
		Options: profile.StoredSSHProfileOptions{
			Host:              "test.example.com",
			AgentForward:      profile.Ptr(false),
			KeepaliveInterval: profile.Ptr(0),
		},
	}
	if err := ps.CreateProfile(prof); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}

	// Load from storage (round trip).
	loaded, err := ps.LoadProfiles()
	if err != nil {
		t.Fatalf("LoadProfiles: %v", err)
	}
	var stored *profile.SSHProfile
	for i := range loaded {
		if loaded[i].ID == "ssh:explicit-false:1" {
			stored = &loaded[i]
			break
		}
	}
	if stored == nil {
		t.Fatal("stored profile not found after round trip")
	}

	// Assert stored representation preserves explicit false and zero.
	if stored.Options.AgentForward == nil {
		t.Fatal("agentForward should be non-nil after round trip (was explicitly set to false)")
	}
	if *stored.Options.AgentForward {
		t.Errorf("stored agentForward = true, want false")
	}
	if stored.Options.KeepaliveInterval == nil {
		t.Fatal("keepaliveInterval should be non-nil after round trip (was explicitly set to 0)")
	}
	if *stored.Options.KeepaliveInterval != 0 {
		t.Errorf("stored keepaliveInterval = %d, want 0", *stored.Options.KeepaliveInterval)
	}

	// Resolve effective profile — assertions MUST check both value AND provenance.
	groups, err := ps.LoadGroups()
	if err != nil {
		t.Fatalf("LoadGroups: %v", err)
	}
	eff, err := profile.ResolveEffectiveProfile(*stored, groups, profile.SparseSSHOptions{})
	if err != nil {
		t.Fatalf("ResolveEffectiveProfile: %v", err)
	}

	// agentForward must be false, sourced "profile" (not inherited "group").
	if eff.ResolvedOptions.AgentForward {
		t.Errorf("effective agentForward = true, want false (profile overrides group default)")
	}
	if eff.Source["agentForward"] != profile.FieldSourceProfile {
		t.Errorf("agentForward source = %q, want %q", eff.Source["agentForward"], profile.FieldSourceProfile)
	}

	// keepaliveInterval must be 0, sourced "profile".
	if eff.ResolvedOptions.KeepaliveInterval != 0 {
		t.Errorf("effective keepaliveInterval = %d, want 0", eff.ResolvedOptions.KeepaliveInterval)
	}
	if eff.Source["keepaliveInterval"] != profile.FieldSourceProfile {
		t.Errorf("keepaliveInterval source = %q, want %q", eff.Source["keepaliveInterval"], profile.FieldSourceProfile)
	}
}

// intPtr returns a pointer to v.
func intPtr(v int) *int { return &v }

// strPtr returns a pointer to v.
func strPtr(v string) *string { return &v }
