package transport

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/zalando/go-keyring"
)

// candidateHarness wires a WSServer with a profile store and a keychain
// credential store, ready for candidate-staging tests.
type candidateHarness struct {
	t    *testing.T
	ws   *WSServer
	ps   *profile.JSONStore
	cs   credential.SecretStore
	conn *websocket.Conn
}

func newCandidateHarness(t *testing.T) *candidateHarness {
	t.Helper()
	keyring.MockInit()
	dir := t.TempDir()
	ps := profile.NewJSONStore(dir + "/p.json")
	cs := credential.NewKeychain()
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps), WithCredentialMetadataRepository(ps), WithCredentialStore(cs))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })
	return &candidateHarness{t: t, ws: ws, ps: ps, cs: cs, conn: conn}
}

func (h *candidateHarness) createCredentialViaRPC(c profile.Credential) string {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "credentials.create", c)
	var got struct {
		Result profile.Credential `json:"result"`
	}
	if err := json.Unmarshal(resp, &got); err != nil {
		h.t.Fatalf("unmarshal create result: %v\nraw: %s", err, string(resp))
	}
	if got.Result.ID == "" {
		h.t.Fatalf("create returned empty id: %s", string(resp))
	}
	return got.Result.ID
}

func (h *candidateHarness) stagePasswordViaRPC(credID, password string) {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "credentials.stagePassword", map[string]any{
		"credentialId": credID,
		"password":     password,
	})
	var got struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &got); err != nil || !got.Result {
		h.t.Fatalf("stagePassword failed: %v\nraw: %s", err, string(resp))
	}
}

func (h *candidateHarness) discardCandidateViaRPC(credID string) {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "credentials.discardCandidate", map[string]any{
		"credentialId": credID,
	})
	var got struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &got); err != nil || !got.Result {
		h.t.Fatalf("discardCandidate failed: %v\nraw: %s", err, string(resp))
	}
}

func (h *candidateHarness) loadCredential(id string) profile.Credential {
	h.t.Helper()
	creds, err := h.ps.LoadCredentials()
	if err != nil {
		h.t.Fatalf("LoadCredentials: %v", err)
	}
	for _, c := range creds {
		if c.ID == id {
			return c
		}
	}
	h.t.Fatalf("credential %s not found", id)
	return profile.Credential{}
}

// TestCandidateStageDoesNotAffectCurrent verifies the core invariant:
// staging a candidate creates a new version with its own secret material
// but leaves CurrentVersionID and the current version's references unchanged.
func TestCandidateStageDoesNotAffectCurrent(t *testing.T) {
	h := newCandidateHarness(t)

	id := h.createCredentialViaRPC(profile.Credential{
		Name:     "test-cred",
		Username: "deploy",
		Auth:     profile.AuthPassword,
	})

	// First save a password via the normal path to establish a current version.
	resp := jsonrpcCall(t, h.conn, "credentials.savePassword", map[string]any{
		"credentialId": id,
		"password":     "current-secret",
	})
	var saveResult struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &saveResult); err != nil || !saveResult.Result {
		t.Fatalf("savePassword precondition failed: %v\nraw: %s", err, string(resp))
	}

	// Record what the current version looks like before staging.
	before := h.loadCredential(id)
	currentBefore, currentOK := before.Current()
	if !currentOK {
		t.Fatal("no current version after savePassword")
	}
	beforeCurrentID := before.CurrentVersionID
	beforeCurrentSecretID := currentBefore.PasswordSecretID

	// Stage a candidate with different password material.
	h.stagePasswordViaRPC(id, "candidate-secret")

	after := h.loadCredential(id)

	// INVARIANT 1: CurrentVersionID did not change.
	if after.CurrentVersionID != beforeCurrentID {
		t.Errorf("CurrentVersionID changed from %q to %q after staging candidate",
			beforeCurrentID, after.CurrentVersionID)
	}

	// INVARIANT 2: Current() returns the same version with the same secret ref.
	currentAfter, currentOK := after.Current()
	if !currentOK {
		t.Fatal("no current version after staging candidate")
	}
	if currentAfter.PasswordSecretID != beforeCurrentSecretID {
		t.Errorf("current version secret changed from %q to %q after staging candidate",
			beforeCurrentSecretID, currentAfter.PasswordSecretID)
	}

	// INVARIANT 3: CandidateVersionID is set and points to a different version.
	if after.CandidateVersionID == "" {
		t.Fatal("CandidateVersionID not set after staging")
	}
	if after.CandidateVersionID == after.CurrentVersionID {
		t.Error("CandidateVersionID equals CurrentVersionID — candidate must not be current")
	}

	// INVARIANT 4: Candidate() returns a version with the staged secret.
	candidate, candidateOK := after.Candidate()
	if !candidateOK {
		t.Fatal("Candidate() returned false after staging")
	}
	if candidate.ID != after.CandidateVersionID {
		t.Errorf("Candidate().ID = %q, want %q", candidate.ID, after.CandidateVersionID)
	}
	if candidate.PasswordSecretID == "" {
		t.Error("candidate version has no password secret reference")
	}
	if candidate.PasswordSecretID == beforeCurrentSecretID {
		t.Error("candidate version shares the current secret — must use its own")
	}

	// INVARIANT 5: The candidate secret exists in the secret store.
	secretID := credential.SecretID(candidate.PasswordSecretID)
	if ok, err := h.cs.Exists(secretID); err != nil || !ok {
		t.Errorf("candidate secret %q missing in secret store (err=%v)", secretID, err)
	}
}

// TestCandidateDiscardRemovesVersion verifies that discarding a candidate:
// clears CandidateVersionID, removes the version from Versions, and deletes
// its secret from the secret store. The current version is untouched.
func TestCandidateDiscardRemovesVersion(t *testing.T) {
	h := newCandidateHarness(t)

	id := h.createCredentialViaRPC(profile.Credential{
		Name:     "test-cred",
		Username: "deploy",
		Auth:     profile.AuthPassword,
	})

	// Establish a current version.
	resp := jsonrpcCall(t, h.conn, "credentials.savePassword", map[string]any{
		"credentialId": id,
		"password":     "current-secret",
	})
	var saveResult struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &saveResult); err != nil || !saveResult.Result {
		t.Fatalf("savePassword precondition failed: %v\nraw: %s", err, string(resp))
	}

	// Stage a candidate and capture its secret ID.
	h.stagePasswordViaRPC(id, "candidate-secret")
	withCandidate := h.loadCredential(id)
	cand, _ := withCandidate.Candidate()
	candidateSecretID := credential.SecretID(cand.PasswordSecretID)

	// Verify the candidate secret exists.
	if ok, err := h.cs.Exists(candidateSecretID); err != nil || !ok {
		t.Fatalf("candidate secret not found before discard (err=%v)", err)
	}

	currentVersionID := withCandidate.CurrentVersionID
	currentVersionCount := len(withCandidate.Versions)

	// Discard the candidate.
	h.discardCandidateViaRPC(id)

	after := h.loadCredential(id)

	// INVARIANT 1: CandidateVersionID is cleared.
	if after.CandidateVersionID != "" {
		t.Errorf("CandidateVersionID = %q after discard, want empty", after.CandidateVersionID)
	}

	// INVARIANT 2: CurrentVersionID is unchanged.
	if after.CurrentVersionID != currentVersionID {
		t.Errorf("CurrentVersionID changed from %q to %q after discarding candidate",
			currentVersionID, after.CurrentVersionID)
	}

	// INVARIANT 3: The candidate version is removed from the list.
	if _, ok := after.Candidate(); ok {
		t.Error("Candidate() returned true after discard")
	}
	expectedCount := currentVersionCount - 1
	if len(after.Versions) != expectedCount {
		t.Errorf("len(Versions) = %d after discard, want %d (one version removed)",
			len(after.Versions), expectedCount)
	}

	// INVARIANT 4: The candidate version's ID no longer appears.
	for _, v := range after.Versions {
		if v.ID == cand.ID {
			t.Errorf("candidate version %q still present in Versions after discard", v.ID)
		}
	}

	// INVARIANT 5: The candidate's secret is deleted from the store.
	if ok, err := h.cs.Exists(candidateSecretID); err == nil && ok {
		t.Error("candidate secret still exists in secret store after discard")
	}
}

// TestCandidateDiscardIsIdempotent verifies that calling discardCandidate
// when no candidate exists returns success (idempotent).
func TestCandidateDiscardIsIdempotent(t *testing.T) {
	h := newCandidateHarness(t)

	id := h.createCredentialViaRPC(profile.Credential{
		Name:     "test-cred",
		Username: "deploy",
		Auth:     profile.AuthPassword,
	})

	// Establish a current version.
	resp := jsonrpcCall(t, h.conn, "credentials.savePassword", map[string]any{
		"credentialId": id,
		"password":     "current-secret",
	})
	var saveResult struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &saveResult); err != nil || !saveResult.Result {
		t.Fatalf("savePassword precondition failed: %v\nraw: %s", err, string(resp))
	}

	// Discard when no candidate exists — must succeed.
	h.discardCandidateViaRPC(id)

	// Double-discard must also succeed (idempotent).
	h.discardCandidateViaRPC(id)
}

// TestCandidateStageOneAtATime verifies that staging a second candidate
// while one already exists returns an error.
func TestCandidateStageOneAtATime(t *testing.T) {
	h := newCandidateHarness(t)

	id := h.createCredentialViaRPC(profile.Credential{
		Name:     "test-cred",
		Username: "deploy",
		Auth:     profile.AuthPassword,
	})

	// Establish a current version.
	resp := jsonrpcCall(t, h.conn, "credentials.savePassword", map[string]any{
		"credentialId": id,
		"password":     "current-secret",
	})
	var saveResult struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &saveResult); err != nil || !saveResult.Result {
		t.Fatalf("savePassword precondition failed: %v\nraw: %s", err, string(resp))
	}

	// Stage first candidate.
	h.stagePasswordViaRPC(id, "candidate-1")

	// Stage second candidate — must fail.
	resp2 := jsonrpcCall(t, h.conn, "credentials.stagePassword", map[string]any{
		"credentialId": id,
		"password":     "candidate-2",
	})
	var errResp struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp2, &errResp); err != nil {
		t.Fatalf("unmarshal error response: %v\nraw: %s", err, string(resp2))
	}
	if errResp.Error == nil {
		t.Fatal("expected error when staging second candidate, got success")
	}

	// Verify the first candidate is still intact.
	cred := h.loadCredential(id)
	if cred.CandidateVersionID == "" {
		t.Fatal("first candidate was removed after failed second stage")
	}
}

// TestCandidateStageThenSavePassword verifies that savePassword (which changes
// CurrentVersionID) does NOT remove the candidate. They are orthogonal.
func TestCandidateStageThenSavePassword(t *testing.T) {
	h := newCandidateHarness(t)

	id := h.createCredentialViaRPC(profile.Credential{
		Name:     "test-cred",
		Username: "deploy",
		Auth:     profile.AuthPassword,
	})

	// Establish a current version.
	resp := jsonrpcCall(t, h.conn, "credentials.savePassword", map[string]any{
		"credentialId": id,
		"password":     "current-secret",
	})
	var saveResult struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &saveResult); err != nil || !saveResult.Result {
		t.Fatalf("savePassword precondition failed: %v\nraw: %s", err, string(resp))
	}

	// Stage a candidate.
	h.stagePasswordViaRPC(id, "candidate-secret")
	candidateVersionID := h.loadCredential(id).CandidateVersionID

	// Save a new current password (simulates normal password change while rollout is staged).
	resp = jsonrpcCall(t, h.conn, "credentials.savePassword", map[string]any{
		"credentialId": id,
		"password":     "new-current-secret",
	})
	if err := json.Unmarshal(resp, &saveResult); err != nil || !saveResult.Result {
		t.Fatalf("savePassword after stage failed: %v\nraw: %s", err, string(resp))
	}

	// Candidate must survive.
	after := h.loadCredential(id)
	if after.CandidateVersionID != candidateVersionID {
		t.Errorf("CandidateVersionID changed from %q to %q after savePassword",
			candidateVersionID, after.CandidateVersionID)
	}
}

// TestCandidateStageDoesNotAffectHasPassword verifies that credentials.hasPassword
// continues to check the current version, not the candidate.
func TestCandidateStageDoesNotAffectHasPassword(t *testing.T) {
	h := newCandidateHarness(t)

	id := h.createCredentialViaRPC(profile.Credential{
		Name:     "test-cred",
		Username: "deploy",
		Auth:     profile.AuthPassword,
	})

	// hasPassword must be false before any password is saved.
	resp := jsonrpcCall(t, h.conn, "credentials.hasPassword", map[string]any{
		"credentialId": id,
	})
	var hasResp struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &hasResp); err != nil {
		t.Fatalf("unmarshal hasPassword: %v\nraw: %s", err, string(resp))
	}

	// Stage a candidate without a current password.
	h.stagePasswordViaRPC(id, "candidate-only")

	// hasPassword must still be false — no current version has a password.
	resp = jsonrpcCall(t, h.conn, "credentials.hasPassword", map[string]any{
		"credentialId": id,
	})
	if err := json.Unmarshal(resp, &hasResp); err != nil {
		t.Fatalf("unmarshal hasPassword after stage: %v\nraw: %s", err, string(resp))
	}
	if hasResp.Result {
		t.Error("hasPassword returned true after staging candidate without current password")
	}
}
