package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/session"
	"github.com/zalando/go-keyring"
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
	probeStore  *ProbeResultStore
	spyRegistry *spySessionRegistry
	conn        *websocket.Conn
}

func newVersionsHarness(t *testing.T, withSpy bool) *versionsHarness {
	t.Helper()
	keyring.MockInit()
	dir := t.TempDir()
	ps := profile.NewJSONStore(dir + "/p.json")
	cs := credential.NewKeychain()
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
	return &versionsHarness{t: t, ws: ws, ps: ps, probeStore: probeStore, spyRegistry: spy, conn: conn}
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
	// Create secrets in the keychain.
	for _, v := range versions {
		if v.PasswordSecretID != "" {
			cs := credential.NewKeychain()
			if err := cs.Set(credential.SecretID(v.PasswordSecretID), credential.NewSecret("pw-"+v.ID)); err != nil {
				h.t.Fatalf("set secret for %s: %v", v.ID, err)
			}
		}
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
