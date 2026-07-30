package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/session"
)

// ---------------------------------------------------------------------------
// spySessionRegistry — counts Close calls and provides session lookup
// for retire/revoke testing.
// ---------------------------------------------------------------------------

type spySession struct {
	id                  session.ID
	credentialID        string
	credentialVersionID string
}

type spySessionRegistry struct {
	sessions   []spySession
	closeCalls int
}

func (s *spySessionRegistry) FindByCredentialVersion(credentialID, versionID string) []session.ID {
	var ids []session.ID
	for _, sess := range s.sessions {
		if sess.credentialID == credentialID && sess.credentialVersionID == versionID {
			ids = append(ids, sess.id)
		}
	}
	return ids
}

func (s *spySessionRegistry) Close(id session.ID) error {
	s.closeCalls++
	return nil
}

func (s *spySessionRegistry) addSession(credID, versionID string) {
	s.sessions = append(s.sessions, spySession{
		id:                  session.ID(fmt.Sprintf("%d", len(s.sessions)+1)),
		credentialID:        credID,
		credentialVersionID: versionID,
	})
}

// liveCount returns the number of sessions still registered.
func (s *spySessionRegistry) liveCount() int {
	return len(s.sessions)
}

// ---------------------------------------------------------------------------
// versionsHarness — wires a WSServer with everything versions tests need
// ---------------------------------------------------------------------------

type versionsHarness struct {
	t           *testing.T
	ws          *WSServer
	ps          *profile.JSONStore
	cs          credential.SecretStore
	probeStore  *ProbeResultStore
	spyRegistry *spySessionRegistry
	conn        *websocket.Conn
}

func newVersionsHarness(t *testing.T, withSpy bool) *versionsHarness {
	t.Helper()
	dir := t.TempDir()
	ps := profile.NewJSONStore(dir + "/p.json")
	cs := newTestStore()
	probeStore := NewProbeResultStore()
	svc := profile.NewProfileService(ps)

	opts := []WSServerOption{
		WithProfileRepository(ps),
		WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps),
		WithCredentialStore(cs),
		WithProfileService(svc),
		WithProbeResultStore(probeStore),
	}

	var spy *spySessionRegistry
	if withSpy {
		spy = &spySessionRegistry{}
		opts = append(opts, WithVersionSessionRegistry(spy))
	}

	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)), opts...)
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })
	return &versionsHarness{t: t, ws: ws, ps: ps, cs: cs, probeStore: probeStore, spyRegistry: spy, conn: conn}
}

type rpcErrorResponse struct {
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Result json.RawMessage `json:"result"`
}

func (h *versionsHarness) createTestCredential(versions []profile.CredentialVersion, currentID, candidateID string) string {
	h.t.Helper()

	// Create secrets FIRST so we can use their generated IDs in the versions.
	for i, v := range versions {
		if v.PasswordSecretID != "" {
			id, err := h.cs.Create(context.Background(), credential.NewSecret("pw-"+v.ID))
			if err != nil {
				h.t.Fatalf("create secret for %s: %v", v.ID, err)
			}
			versions[i].PasswordSecretID = string(id)
		}
	}

	cred := profile.Credential{
		ID:                 "cred:test:1",
		Name:               "test",
		Username:           "tu",
		Auth:               "password",
		Versions:           versions,
		CurrentVersionID:   currentID,
		CandidateVersionID: candidateID,
	}
	if err := h.ps.CreateCredential(cred); err != nil {
		h.t.Fatalf("CreateCredential: %v", err)
	}
	return cred.ID
}

func (h *versionsHarness) addProbeResult(credID, versionID string, outcome ProbeOutcome) {
	h.probeStore.Store(ProbeResultRecord{
		CredentialID: credID,
		Identity: ProbeResultIdentity{
			Endpoint:           "host:22",
			HostKeyFingerprint: "SHA256:abc",
			CredentialVersion:  versionID,
			Username:           "tu",
			AuthPolicy:         "password",
			Timestamp:          time.Now(),
		},
		Outcome: outcome,
	})
}

// ---------------------------------------------------------------------------
// versions.promote
// ---------------------------------------------------------------------------

func TestVersionsPromote_Success(t *testing.T) {
	h := newVersionsHarness(t, false)

	h.createTestCredential([]profile.CredentialVersion{
		{ID: "v1", PasswordSecretID: "sec:1"},
		{ID: "v2", PasswordSecretID: "sec:2"},
	}, "v1", "v2")

	h.addProbeResult("cred:test:1", "v2", OutcomeAccepted)
	h.addProbeResult("cred:test:1", "v2", OutcomeAccepted)
	h.addProbeResult("cred:test:1", "v2", OutcomeAccepted)

	resp := jsonrpcCall(t, h.conn, "versions.promote", map[string]any{
		"credentialId": "cred:test:1",
		"threshold":    map[string]any{"minAccepted": 3},
	})

	var result struct {
		Result struct {
			VersionID string `json:"versionId"`
			Evidence  *struct {
				Accepted int `json:"accepted"`
				Total    int `json:"total"`
			} `json:"evidence"`
		} `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if result.Result.VersionID != "v2" {
		t.Errorf("VersionID = %q, want v2", result.Result.VersionID)
	}
	if result.Result.Evidence == nil {
		t.Fatal("expected evidence in response")
	}
	if result.Result.Evidence.Accepted != 3 {
		t.Errorf("accepted = %d, want 3", result.Result.Evidence.Accepted)
	}
	if result.Result.Evidence.Total != 3 {
		t.Errorf("total = %d, want 3", result.Result.Evidence.Total)
	}

	// Verify store state.
	creds, err := h.ps.LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	for _, c := range creds {
		if c.ID == "cred:test:1" {
			if c.CurrentVersionID != "v2" {
				t.Errorf("store CurrentVersionID = %q, want v2", c.CurrentVersionID)
			}
			if c.CandidateVersionID != "" {
				t.Errorf("store CandidateVersionID = %q, want empty", c.CandidateVersionID)
			}
		}
	}
}

func TestVersionsPromote_ThresholdNotMet(t *testing.T) {
	h := newVersionsHarness(t, false)

	h.createTestCredential([]profile.CredentialVersion{
		{ID: "v1", PasswordSecretID: "sec:1"},
		{ID: "v2", PasswordSecretID: "sec:2"},
	}, "v1", "v2")

	// 1 accepted out of 3, need 3.
	h.addProbeResult("cred:test:1", "v2", OutcomeAccepted)
	h.addProbeResult("cred:test:1", "v2", OutcomeRejected)
	h.addProbeResult("cred:test:1", "v2", OutcomeUnreachable)

	resp := jsonrpcCall(t, h.conn, "versions.promote", map[string]any{
		"credentialId": "cred:test:1",
		"threshold":    map[string]any{"minAccepted": 3},
	})

	var errResp rpcErrorResponse
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if errResp.Error == nil {
		t.Fatal("expected error response, got result")
	}
	if errResp.Error.Code != -32603 {
		t.Errorf("error code = %d, want -32603", errResp.Error.Code)
	}

	// Verify nothing changed.
	creds, err := h.ps.LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	for _, c := range creds {
		if c.ID == "cred:test:1" {
			if c.CurrentVersionID != "v1" {
				t.Errorf("after failed promote CurrentVersionID = %q, want v1", c.CurrentVersionID)
			}
			if c.CandidateVersionID != "v2" {
				t.Errorf("after failed promote CandidateVersionID = %q, want v2", c.CandidateVersionID)
			}
		}
	}
}

func TestVersionsPromote_NoCandidate(t *testing.T) {
	h := newVersionsHarness(t, false)

	h.createTestCredential([]profile.CredentialVersion{
		{ID: "v1", PasswordSecretID: "sec:1"},
	}, "v1", "")

	resp := jsonrpcCall(t, h.conn, "versions.promote", map[string]any{
		"credentialId": "cred:test:1",
		"threshold":    map[string]any{"minAccepted": 1},
	})

	var errResp rpcErrorResponse
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if errResp.Error == nil {
		t.Fatal("expected error for missing candidate")
	}
}

// ---------------------------------------------------------------------------
// Promotion drains nothing — the bead's key invariant
// ---------------------------------------------------------------------------

func TestVersionsPromote_DrainsNothing(t *testing.T) {
	h := newVersionsHarness(t, true)

	h.createTestCredential([]profile.CredentialVersion{
		{ID: "v1", PasswordSecretID: "sec:1"},
		{ID: "v2", PasswordSecretID: "sec:2"},
	}, "v1", "v2")

	h.spyRegistry.addSession("cred:test:1", "v1")
	h.spyRegistry.addSession("cred:test:1", "v1")

	h.addProbeResult("cred:test:1", "v2", OutcomeAccepted)
	h.addProbeResult("cred:test:1", "v2", OutcomeAccepted)
	h.addProbeResult("cred:test:1", "v2", OutcomeAccepted)

	resp := jsonrpcCall(t, h.conn, "versions.promote", map[string]any{
		"credentialId": "cred:test:1",
		"threshold":    map[string]any{"minAccepted": 3},
	})

	var errResp rpcErrorResponse
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if errResp.Error != nil {
		t.Fatalf("promote returned error: %s", errResp.Error.Message)
	}
	if h.spyRegistry.closeCalls != 0 {
		t.Errorf("Close called %d times during promote, want 0 (promotion must not drain)", h.spyRegistry.closeCalls)
	}
	if h.spyRegistry.liveCount() != 2 {
		t.Errorf("sessions live count = %d, want 2 (all sessions must survive promotion)", h.spyRegistry.liveCount())
	}
}

// ---------------------------------------------------------------------------
// versions.retire
// ---------------------------------------------------------------------------

func TestVersionsRetire_WithoutDrain(t *testing.T) {
	h := newVersionsHarness(t, true)

	h.createTestCredential([]profile.CredentialVersion{
		{ID: "v1", PasswordSecretID: "sec:1"},
		{ID: "v2", PasswordSecretID: "sec:2"},
	}, "v2", "")

	h.spyRegistry.addSession("cred:test:1", "v1")

	resp := jsonrpcCall(t, h.conn, "versions.retire", map[string]any{
		"credentialId":  "cred:test:1",
		"versionId":     "v1",
		"drainExisting": false,
	})

	var result rpcErrorResponse
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if result.Error != nil {
		t.Fatalf("retire returned error: %s", result.Error.Message)
	}
	if h.spyRegistry.closeCalls != 0 {
		t.Errorf("Close called %d times when drainExisting=false, want 0", h.spyRegistry.closeCalls)
	}
}

func TestVersionsRetire_WithDrain(t *testing.T) {
	h := newVersionsHarness(t, true)

	h.createTestCredential([]profile.CredentialVersion{
		{ID: "v1", PasswordSecretID: "sec:1"},
		{ID: "v2", PasswordSecretID: "sec:2"},
	}, "v2", "")

	// Two sessions on v1, one on v2 — draining v1 must close 2 sessions.
	h.spyRegistry.addSession("cred:test:1", "v1")
	h.spyRegistry.addSession("cred:test:1", "v1")
	h.spyRegistry.addSession("cred:test:1", "v2")

	resp := jsonrpcCall(t, h.conn, "versions.retire", map[string]any{
		"credentialId":  "cred:test:1",
		"versionId":     "v1",
		"drainExisting": true,
	})

	var result struct {
		Result struct {
			VersionID      string `json:"versionId"`
			Retired        bool   `json:"retired"`
			SessionsClosed int    `json:"sessionsClosed"`
		} `json:"result"`
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if result.Error != nil {
		t.Fatalf("retire returned error: %s", string(result.Error))
	}
	if !result.Result.Retired {
		t.Error("retired = false, want true")
	}
	if result.Result.SessionsClosed != 2 {
		t.Errorf("SessionsClosed = %d, want 2 (only v1 sessions)", result.Result.SessionsClosed)
	}
}

// ---------------------------------------------------------------------------
// versions.revoke
// ---------------------------------------------------------------------------

func TestVersionsRevoke_ClosesOnlyVersionSessions(t *testing.T) {
	h := newVersionsHarness(t, true)

	h.createTestCredential([]profile.CredentialVersion{
		{ID: "v1", PasswordSecretID: "sec:1"},
		{ID: "v2", PasswordSecretID: "sec:2"},
	}, "v2", "")

	// Three sessions on v1, two on v2 — revoking v1 must close exactly 3.
	h.spyRegistry.addSession("cred:test:1", "v1")
	h.spyRegistry.addSession("cred:test:1", "v1")
	h.spyRegistry.addSession("cred:test:1", "v1")
	h.spyRegistry.addSession("cred:test:1", "v2")
	h.spyRegistry.addSession("cred:test:1", "v2")

	resp := jsonrpcCall(t, h.conn, "versions.revoke", map[string]any{
		"credentialId": "cred:test:1",
		"versionId":    "v1",
	})

	var result struct {
		Result struct {
			VersionID      string `json:"versionId"`
			Retired        bool   `json:"retired"`
			SessionsClosed int    `json:"sessionsClosed"`
		} `json:"result"`
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if result.Error != nil {
		t.Fatalf("revoke returned error: %s", string(result.Error))
	}
	if !result.Result.Retired {
		t.Error("retired = false, want true")
	}
	if result.Result.SessionsClosed != 3 {
		t.Errorf("SessionsClosed = %d, want 3 (only v1 sessions, v2 sessions untouched)", result.Result.SessionsClosed)
	}

	// Verify v1 is retired in the store.
	creds, err := h.ps.LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	for _, c := range creds {
		if c.ID == "cred:test:1" {
			v, ok := c.Version("v1")
			if !ok {
				t.Fatal("v1 not found after revoke")
			}
			if v.RetiredAt == nil {
				t.Error("v1 RetiredAt is nil, want non-nil after revoke")
			}
		}
	}
}

// ---------------------------------------------------------------------------
// versions.impact
// ---------------------------------------------------------------------------

// TestVersionsImpact_LiveSessionsAndScoping verifies that liveSessions
// reports sessions on the matching credential+version and excludes sessions
// on a different version of the same credential.
func TestVersionsImpact_LiveSessionsAndScoping(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	reg := newRegWithStub(log.NewSlogAdapter(nil))

	ws := NewWSServer(
		log.NewSlogAdapter(nil), reg,
		WithProfileRepository(ps),
		WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps),
	)
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Create credential with v1 (current) and v2.
	cred := profile.Credential{
		ID: "cred:test:1", Name: "test", Username: "tu", Auth: "password",
		Versions: []profile.CredentialVersion{
			{ID: "v1", PasswordSecretID: "sec:1"},
			{ID: "v2", PasswordSecretID: "sec:2"},
		},
		CurrentVersionID: "v1",
	}
	if err := ps.CreateCredential(cred); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	// Create profile A with direct credential ref.
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base: profile.Base{ID: "ssh:web:1", Name: "web-01", Type: "ssh"},
		Options: profile.StoredSSHProfileOptions{
			Host:         "web01.example.com",
			CredentialID: "cred:test:1",
		},
	})

	// Open a session on v1.
	sessV1, err := reg.Open(ctx, session.Config{
		ProfileID:           "ssh:web:1",
		CredentialID:        "cred:test:1",
		CredentialVersionID: "v1",
	})
	if err != nil {
		t.Fatalf("registry.Open v1: %v", err)
	}
	defer reg.Close(sessV1.ID()) //nolint:errcheck

	// Open a session on v2 (same credential, different version).
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base: profile.Base{ID: "ssh:web:2", Name: "web-02", Type: "ssh"},
		Options: profile.StoredSSHProfileOptions{
			Host:         "web02.example.com",
			CredentialID: "cred:test:1",
		},
	})

	sessV2, err := reg.Open(ctx, session.Config{
		ProfileID:           "ssh:web:2",
		CredentialID:        "cred:test:1",
		CredentialVersionID: "v2",
	})
	if err != nil {
		t.Fatalf("registry.Open v2: %v", err)
	}
	defer reg.Close(sessV2.ID()) //nolint:errcheck

	// Call impact for v1.
	resp := jsonrpcCall(t, conn, "versions.impact", map[string]any{
		"credentialId": "cred:test:1",
		"versionId":    "v1",
	})

	var result struct {
		Result versionsImpactResult `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Only the v1 session should appear.
	if len(result.Result.LiveSessions) != 1 {
		t.Fatalf("expected 1 live session, got %d", len(result.Result.LiveSessions))
	}
	if result.Result.LiveSessions[0].ProfileID != "ssh:web:1" {
		t.Errorf("expected profile ssh:web:1, got %s", result.Result.LiveSessions[0].ProfileID)
	}
	if result.Result.LiveSessions[0].ProfileName != "web-01" {
		t.Errorf("expected profile name web-01, got %s", result.Result.LiveSessions[0].ProfileName)
	}

	// v1 should be current, not v2.
	if !result.Result.IsCurrent {
		t.Error("expected isCurrent=true for v1")
	}
	if result.Result.IsCandidate {
		t.Error("expected isCandidate=false for v1")
	}
	if result.Result.Retired {
		t.Error("expected retired=false for v1 (not retired)")
	}

	// Verify session ID is populated (not empty string).
	if result.Result.LiveSessions[0].SessionID == "" {
		t.Error("expected non-empty sessionId")
	}

	// Verify v2 session is NOT present.
	for _, ls := range result.Result.LiveSessions {
		if ls.ProfileID == "ssh:web:2" {
			t.Error("v2 session should not be in liveSessions for v1 impact")
		}
	}
}

// TestVersionsImpact_PinnedAndUsingProfiles verifies pinnedProfiles and
// profilesUsing reflect which profiles would resolve to this version,
// including group-inherited credentials.
func TestVersionsImpact_PinnedAndUsingProfiles(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	reg := newRegWithStub(log.NewSlogAdapter(nil))

	ws := NewWSServer(
		log.NewSlogAdapter(nil), reg,
		WithProfileRepository(ps),
		WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps),
	)
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Create credential with v1 (current) and v2.
	cred := profile.Credential{
		ID: "cred:test:1", Name: "test", Username: "tu", Auth: "password",
		Versions: []profile.CredentialVersion{
			{ID: "v1", PasswordSecretID: "sec:1"},
			{ID: "v2", PasswordSecretID: "sec:2"},
		},
		CurrentVersionID: "v1",
	}
	if err := ps.CreateCredential(cred); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	// Profile A: directly references credential, unpinned → uses v1 (current).
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base: profile.Base{ID: "ssh:web:1", Name: "web-01", Type: "ssh"},
		Options: profile.StoredSSHProfileOptions{
			Host:         "web01.example.com",
			CredentialID: "cred:test:1",
		},
	})

	// Profile B: pinned to v2 (different version).
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base: profile.Base{
			ID:              "ssh:legacy:1",
			Name:            "legacy-db",
			Type:            "ssh",
			PinnedVersionID: "v2",
		},
		Options: profile.StoredSSHProfileOptions{
			Host:         "legacy.example.com",
			CredentialID: "cred:test:1",
		},
	})

	// Profile C: inherits credential from group defaults.
	jsonrpcCall(t, conn, "groups.create", profile.ProfileGroup{
		ID: "g1", Name: "Prod",
		Defaults: &profile.ProfileDefaults{
			SparseSSHOptions: profile.SparseSSHOptions{
				CredentialID: profile.Ptr("cred:test:1"),
			},
		},
	})
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base:    profile.Base{ID: "ssh:grouped:1", Name: "grouped-server", Type: "ssh", Group: "g1"},
		Options: profile.StoredSSHProfileOptions{Host: "grouped.example.com"},
	})

	// Profile D: uses a different credential entirely.
	cred2 := profile.Credential{
		ID: "cred:other:1", Name: "other", Username: "ou", Auth: "password",
		Versions: []profile.CredentialVersion{
			{ID: "v1", PasswordSecretID: "sec:other"},
		},
		CurrentVersionID: "v1",
	}
	if err := ps.CreateCredential(cred2); err != nil {
		t.Fatalf("CreateCredential cred2: %v", err)
	}
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base: profile.Base{ID: "ssh:other:1", Name: "other-server", Type: "ssh"},
		Options: profile.StoredSSHProfileOptions{
			Host:         "other.example.com",
			CredentialID: "cred:other:1",
		},
	})

	// Call impact for v1.
	resp := jsonrpcCall(t, conn, "versions.impact", map[string]any{
		"credentialId": "cred:test:1",
		"versionId":    "v1",
	})

	var result struct {
		Result versionsImpactResult `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// profilesUsing: profile A (direct, unpinned → v1) and profile C (group inheritance, unpinned → v1).
	// Profile B is pinned to v2 → not using v1.
	// Profile D uses different credential → not included.
	if len(result.Result.ProfilesUsing) != 2 {
		t.Fatalf("expected 2 profilesUsing (A direct + C group), got %d", len(result.Result.ProfilesUsing))
	}

	foundDirect := false
	foundGrouped := false
	for _, pu := range result.Result.ProfilesUsing {
		if pu.ProfileID == "ssh:web:1" {
			foundDirect = true
			if pu.ProfileName != "web-01" {
				t.Errorf("expected profile name web-01, got %s", pu.ProfileName)
			}
		}
		if pu.ProfileID == "ssh:grouped:1" {
			foundGrouped = true
			if pu.ProfileName != "grouped-server" {
				t.Errorf("expected profile name grouped-server, got %s", pu.ProfileName)
			}
		}
	}
	if !foundDirect {
		t.Error("expected ssh:web:1 in profilesUsing (direct credential ref)")
	}
	if !foundGrouped {
		t.Error("expected ssh:grouped:1 in profilesUsing (group inheritance)")
	}

	// pinnedProfiles: none pinned to v1.
	if len(result.Result.PinnedProfiles) != 0 {
		t.Errorf("expected 0 pinnedProfiles for v1, got %d", len(result.Result.PinnedProfiles))
	}

	// Verify profile B (pinned to v2) is NOT in profilesUsing for v1.
	for _, pu := range result.Result.ProfilesUsing {
		if pu.ProfileID == "ssh:legacy:1" {
			t.Error("profile pinned to v2 should not be in profilesUsing for v1")
		}
	}
}

// TestVersionsImpact_PinnedVersion verifies pinnedProfiles correctly identifies
// profiles pinned to the requested version.
func TestVersionsImpact_PinnedVersion(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	reg := newRegWithStub(log.NewSlogAdapter(nil))

	ws := NewWSServer(
		log.NewSlogAdapter(nil), reg,
		WithProfileRepository(ps),
		WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps),
	)
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	cred := profile.Credential{
		ID: "cred:test:1", Name: "test", Username: "tu", Auth: "password",
		Versions: []profile.CredentialVersion{
			{ID: "v1", PasswordSecretID: "sec:1"},
			{ID: "v2", PasswordSecretID: "sec:2"},
		},
		CurrentVersionID: "v1",
	}
	if err := ps.CreateCredential(cred); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	// Profile pinned to v2.
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base: profile.Base{
			ID:              "ssh:pinned:v2:1",
			Name:            "pinned-to-v2",
			Type:            "ssh",
			PinnedVersionID: "v2",
		},
		Options: profile.StoredSSHProfileOptions{
			Host:         "pinned.example.com",
			CredentialID: "cred:test:1",
		},
	})

	// Profile pinned to v1.
	jsonrpcCall(t, conn, "profiles.create", profile.SSHProfile{
		Base: profile.Base{
			ID:              "ssh:pinned:v1:1",
			Name:            "pinned-to-v1",
			Type:            "ssh",
			PinnedVersionID: "v1",
		},
		Options: profile.StoredSSHProfileOptions{
			Host:         "pinned-v1.example.com",
			CredentialID: "cred:test:1",
		},
	})

	// Impact for v2.
	resp := jsonrpcCall(t, conn, "versions.impact", map[string]any{
		"credentialId": "cred:test:1",
		"versionId":    "v2",
	})

	var result struct {
		Result versionsImpactResult `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Only the v2-pinned profile should be in pinnedProfiles.
	if len(result.Result.PinnedProfiles) != 1 {
		t.Fatalf("expected 1 pinned profile for v2, got %d", len(result.Result.PinnedProfiles))
	}
	if result.Result.PinnedProfiles[0].ProfileID != "ssh:pinned:v2:1" {
		t.Errorf("expected ssh:pinned:v2:1, got %s", result.Result.PinnedProfiles[0].ProfileID)
	}

	// profilesUsing should include only the v2-pinned profile (it's the only
	// profile that resolves to v2 — the other is pinned to v1).
	if len(result.Result.ProfilesUsing) != 1 {
		t.Fatalf("expected 1 profileUsing for v2, got %d", len(result.Result.ProfilesUsing))
	}

	// v2 should not be current.
	if result.Result.IsCurrent {
		t.Error("expected isCurrent=false for v2")
	}
}

// TestVersionsImpact_EmptyResults verifies that empty result lists marshal
// as JSON arrays, never null.
func TestVersionsImpact_EmptyResults(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	reg := newRegWithStub(log.NewSlogAdapter(nil))

	ws := NewWSServer(
		log.NewSlogAdapter(nil), reg,
		WithProfileRepository(ps),
		WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps),
	)
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	// Create a credential with v1 but no profiles and no sessions.
	cred := profile.Credential{
		ID: "cred:empty:1", Name: "empty", Username: "tu", Auth: "password",
		Versions: []profile.CredentialVersion{
			{ID: "v1", PasswordSecretID: "sec:1"},
		},
		CurrentVersionID: "v1",
	}
	if err := ps.CreateCredential(cred); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	resp := jsonrpcCall(t, conn, "versions.impact", map[string]any{
		"credentialId": "cred:empty:1",
		"versionId":    "v1",
	})

	// Assert that liveSessions, pinnedProfiles, profilesUsing are "[]" not null.
	var raw struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(resp, &raw); err != nil {
		t.Fatalf("unmarshal raw: %v", err)
	}

	var fields struct {
		LiveSessions   json.RawMessage `json:"liveSessions"`
		PinnedProfiles json.RawMessage `json:"pinnedProfiles"`
		ProfilesUsing  json.RawMessage `json:"profilesUsing"`
	}
	if err := json.Unmarshal(raw.Result, &fields); err != nil {
		t.Fatalf("unmarshal fields: %v", err)
	}

	if string(fields.LiveSessions) != "[]" {
		t.Errorf("liveSessions should be [], got %s", string(fields.LiveSessions))
	}
	if string(fields.PinnedProfiles) != "[]" {
		t.Errorf("pinnedProfiles should be [], got %s", string(fields.PinnedProfiles))
	}
	if string(fields.ProfilesUsing) != "[]" {
		t.Errorf("profilesUsing should be [], got %s", string(fields.ProfilesUsing))
	}
}

// TestVersionsImpact_Idempotent verifies that calling versions.impact twice
// produces identical results and causes no side effects.
func TestVersionsImpact_Idempotent(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	reg := newRegWithStub(log.NewSlogAdapter(nil))

	ws := NewWSServer(
		log.NewSlogAdapter(nil), reg,
		WithProfileRepository(ps),
		WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps),
	)
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	cred := profile.Credential{
		ID: "cred:idem:1", Name: "idem", Username: "tu", Auth: "password",
		Versions: []profile.CredentialVersion{
			{ID: "v1", PasswordSecretID: "sec:1"},
		},
		CurrentVersionID: "v1",
	}
	if err := ps.CreateCredential(cred); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	params := map[string]any{
		"credentialId": "cred:idem:1",
		"versionId":    "v1",
	}

	resp1 := jsonrpcCall(t, conn, "versions.impact", params)
	resp2 := jsonrpcCall(t, conn, "versions.impact", params)

	// Both responses should be identical.
	if string(resp1) != string(resp2) {
		t.Error("two identical impact calls produced different results")
	}

	// Verify the credential was not mutated — still current, not retired.
	all, err := ps.LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	var found *profile.Credential
	for i, c := range all {
		if c.ID == "cred:idem:1" {
			found = &all[i]
			break
		}
	}
	if found == nil {
		t.Fatal("credential not found after impact call")
	}
	if found.CurrentVersionID != "v1" {
		t.Error("impact should not change current version")
	}
	if len(found.Versions) != 1 {
		t.Error("impact should not add or remove versions")
	}
	if found.Versions[0].RetiredAt != nil {
		t.Error("impact should not retire a version")
	}
}

// TestVersionsImpact_UnknownCredential verifies that an unknown credential ID
// produces an error rather than an empty success.
func TestVersionsImpact_UnknownCredential(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	reg := newRegWithStub(log.NewSlogAdapter(nil))

	ws := NewWSServer(
		log.NewSlogAdapter(nil), reg,
		WithProfileRepository(ps),
		WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps),
	)
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	resp := jsonrpcCall(t, conn, "versions.impact", map[string]any{
		"credentialId": "cred:nonexistent:1",
		"versionId":    "v1",
	})

	var errResp rpcErrorResponse
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if errResp.Error == nil {
		t.Fatal("expected error for unknown credential, got success")
	}
	if errResp.Error.Code != -32602 {
		t.Errorf("expected error code -32602, got %d", errResp.Error.Code)
	}
}

// TestVersionsImpact_UnknownVersion verifies that an unknown version ID
// produces an error rather than an empty success.
func TestVersionsImpact_UnknownVersion(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	reg := newRegWithStub(log.NewSlogAdapter(nil))

	ws := NewWSServer(
		log.NewSlogAdapter(nil), reg,
		WithProfileRepository(ps),
		WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps),
	)
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer conn.Close() //nolint:errcheck

	cred := profile.Credential{
		ID: "cred:noversion:1", Name: "nover", Username: "tu", Auth: "password",
		Versions: []profile.CredentialVersion{
			{ID: "v1", PasswordSecretID: "sec:1"},
		},
		CurrentVersionID: "v1",
	}
	if err := ps.CreateCredential(cred); err != nil {
		t.Fatalf("CreateCredential: %v", err)
	}

	resp := jsonrpcCall(t, conn, "versions.impact", map[string]any{
		"credentialId": "cred:noversion:1",
		"versionId":    "v99",
	})

	var errResp rpcErrorResponse
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if errResp.Error == nil {
		t.Fatal("expected error for unknown version, got success")
	}
	if errResp.Error.Code != -32602 {
		t.Errorf("expected error code -32602, got %d", errResp.Error.Code)
	}
}
