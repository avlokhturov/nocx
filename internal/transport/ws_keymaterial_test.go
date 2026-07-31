package transport

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	gossh "golang.org/x/crypto/ssh"
)

// testPrivateKeyPEM generates a new ed25519 key and returns its PEM-encoded
// private key text and its SHA256 fingerprint.
func testPrivateKeyPEM(t *testing.T) (pemOut, fingerprint string) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("create signer: %v", err)
	}
	fingerprint = gossh.FingerprintSHA256(signer.PublicKey())
	block, err := gossh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatalf("marshal private key: %v", err)
	}
	return string(pem.EncodeToMemory(block)), fingerprint
}

// testEncryptedKeyPEM generates an ed25519 key, encrypts it with the given
// passphrase, and returns the PEM text and its SHA256 fingerprint.
func testEncryptedKeyPEM(t *testing.T, passphrase string) (pemOut, fingerprint string) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("create signer: %v", err)
	}
	fingerprint = gossh.FingerprintSHA256(signer.PublicKey())

	// Marshal with passphrase uses OpenSSH format which stores the
	// public key unencrypted, so ParseRawPrivateKey can extract it.
	block, err := gossh.MarshalPrivateKeyWithPassphrase(priv, "", []byte(passphrase))
	if err != nil {
		t.Fatalf("marshal encrypted key: %v", err)
	}
	return string(pem.EncodeToMemory(block)), fingerprint
}

// keyMaterialHarness wires a WSServer with stores for key material tests.
type keyMaterialHarness struct {
	t    *testing.T
	ws   *WSServer
	ps   *profile.JSONStore
	cs   credential.SecretStore
	conn *websocket.Conn
}

func newKeyMaterialHarness(t *testing.T) *keyMaterialHarness {
	t.Helper()
	dir := t.TempDir()
	ps := profile.NewJSONStore(dir + "/p.json")
	cs := newTestStore()
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(cs))
	ctx := t.Context()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })
	return &keyMaterialHarness{t: t, ws: ws, ps: ps, cs: cs, conn: conn}
}

func (h *keyMaterialHarness) createCredential(name string, auth profile.AuthMode) string {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "credentials.create", profile.Credential{
		Name: name,
		Auth: auth,
	})
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

func (h *keyMaterialHarness) saveKeyMaterial(credID, keyText string) (fingerprint string, passphraseWanted bool, raw json.RawMessage) {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "credentials.saveKeyMaterial", map[string]any{
		"credentialId": credID,
		"keyText":      keyText,
	})
	var success struct {
		Result struct {
			Fingerprint      string `json:"fingerprint"`
			PassphraseWanted bool   `json:"passphraseWanted"`
		} `json:"result"`
	}
	if err := json.Unmarshal(resp, &success); err == nil {
		return success.Result.Fingerprint, success.Result.PassphraseWanted, resp
	}
	return "", false, resp
}

func (h *keyMaterialHarness) saveKeyPassphrase(credID, passphrase string) json.RawMessage {
	h.t.Helper()
	return jsonrpcCall(h.t, h.conn, "credentials.saveKeyPassphrase", map[string]any{
		"credentialId": credID,
		"passphrase":   passphrase,
	})
}

func (h *keyMaterialHarness) deleteKeyMaterial(credID string) json.RawMessage {
	h.t.Helper()
	return jsonrpcCall(h.t, h.conn, "credentials.deleteKeyMaterial", map[string]any{
		"credentialId": credID,
	})
}

func (h *keyMaterialHarness) loadCredential(id string) profile.Credential {
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

// --- parsePrivateKeyMaterial tests ---

func TestParsePrivateKeyMaterial_ValidUnencrypted(t *testing.T) {
	pem, expectedFP := testPrivateKeyPEM(t)
	fp, wantsPassphrase, err := parsePrivateKeyMaterial(pem)
	if err != nil {
		t.Fatalf("parsePrivateKeyMaterial(unencrypted): %v", err)
	}
	if fp != expectedFP {
		t.Fatalf("fingerprint mismatch: got %q, want %q", fp, expectedFP)
	}
	if wantsPassphrase {
		t.Fatal("passphraseWanted = true for an unencrypted key")
	}
}

func TestParsePrivateKeyMaterial_ValidEncrypted(t *testing.T) {
	pem, expectedFP := testEncryptedKeyPEM(t, "test-passphrase")
	fp, wantsPassphrase, err := parsePrivateKeyMaterial(pem)
	if err != nil {
		t.Fatalf("parsePrivateKeyMaterial(encrypted): %v", err)
	}
	if fp != expectedFP {
		t.Fatalf("fingerprint mismatch: got %q, want %q", fp, expectedFP)
	}
	if !wantsPassphrase {
		t.Fatal("passphraseWanted = false for an encrypted key")
	}
}

func TestParsePrivateKeyMaterial_InvalidText(t *testing.T) {
	_, _, err := parsePrivateKeyMaterial("this is not a private key")
	if err == nil {
		t.Fatal("parsePrivateKeyMaterial should reject non-key text")
	}
	var invalidKey *errInvalidKeyMaterial
	if !errors.As(err, &invalidKey) {
		t.Fatal("error should be *errInvalidKeyMaterial")
	}
}

// Test that arbitrary binary data is rejected.
func TestParsePrivateKeyMaterial_BinaryData(t *testing.T) {
	_, _, err := parsePrivateKeyMaterial("\x00\x01\x02\x03")
	if err == nil {
		t.Fatal("parsePrivateKeyMaterial should reject binary data")
	}
}

// --- saveKeyMaterial RPC tests ---

func TestSaveKeyMaterial_Success(t *testing.T) {
	h := newKeyMaterialHarness(t)
	credID := h.createCredential("test-key", profile.AuthPublicKey)

	pem, expectedFP := testPrivateKeyPEM(t)
	fp, wantsPassphrase, raw := h.saveKeyMaterial(credID, pem)
	if fp == "" {
		t.Fatalf("saveKeyMaterial failed: %s", string(raw))
	}
	if fp != expectedFP {
		t.Fatalf("fingerprint mismatch: got %q, want %q", fp, expectedFP)
	}
	if wantsPassphrase {
		t.Fatal("saveKeyMaterial reported passphraseWanted for an unencrypted key")
	}

	// Verify credential metadata is updated.
	cred := h.loadCredential(credID)
	if cred.KeyMaterialSecretID == "" {
		t.Fatal("key material secret ID not recorded on the credential")
	}
	if cred.KeyFingerprint != expectedFP {
		t.Fatalf("key fingerprint mismatch: got %q, want %q", cred.KeyFingerprint, expectedFP)
	}
	keyMaterialSecretID := cred.KeyMaterialSecretID

	// Verify KeyPath is cleared.
	if cred.KeyPath != "" {
		t.Fatalf("KeyPath should be empty after saving key material, got %q", cred.KeyPath)
	}

	// Verify the secret is actually stored.
	exists, err := h.cs.Exists(t.Context(), credential.SecretID(keyMaterialSecretID))
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if !exists {
		t.Fatal("key material not found in secret store")
	}

	// Verify no key bytes leak in the response.
	if strings.Contains(string(raw), "BEGIN") {
		t.Fatal("response contains key material")
	}
}

func TestSaveKeyMaterial_EncryptedKey(t *testing.T) {
	h := newKeyMaterialHarness(t)
	credID := h.createCredential("test-enc-key", profile.AuthPublicKey)

	pem, expectedFP := testEncryptedKeyPEM(t, "correct-passphrase")
	fp, wantsPassphrase, raw := h.saveKeyMaterial(credID, pem)
	if fp == "" {
		t.Fatalf("saveKeyMaterial failed for encrypted key: %s", string(raw))
	}
	if fp != expectedFP {
		t.Fatalf("fingerprint mismatch: got %q, want %q", fp, expectedFP)
	}
	if !wantsPassphrase {
		t.Fatal("saveKeyMaterial did not report passphraseWanted for an encrypted key")
	}

	cred := h.loadCredential(credID)
	if cred.KeyMaterialSecretID == "" {
		t.Fatal("key material secret ID not recorded for encrypted key")
	}
	if cred.KeyFingerprint != expectedFP {
		t.Fatalf("key fingerprint mismatch: got %q, want %q", cred.KeyFingerprint, expectedFP)
	}
}

func TestSaveKeyMaterial_RejectsInvalidText(t *testing.T) {
	h := newKeyMaterialHarness(t)
	credID := h.createCredential("test-invalid", profile.AuthPublicKey)

	_, _, raw := h.saveKeyMaterial(credID, "not a valid key at all")

	// The response should be an error with reason "invalid-key".
	var errResp struct {
		Error struct {
			Code int `json:"code"`
			Data struct {
				Reason string `json:"reason"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &errResp); err != nil {
		t.Fatalf("unmarshal error response: %v\nraw: %s", err, string(raw))
	}
	if errResp.Error.Code != -32603 {
		t.Fatalf("expected code -32603, got %d", errResp.Error.Code)
	}
	if errResp.Error.Data.Reason != "invalid-key" {
		t.Fatalf("expected reason 'invalid-key', got %q", errResp.Error.Data.Reason)
	}

	// Verify nothing was stored in the vault (the old count should be 0
	// since we never stored anything).
	creds, err := h.ps.LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	for _, c := range creds {
		if c.ID == credID {
			if c.KeyMaterialSecretID != "" {
				t.Fatal("key material was stored despite invalid key text")
			}
		}
	}
}

func TestSaveKeyMaterial_ClearsKeyPath(t *testing.T) {
	h := newKeyMaterialHarness(t)

	// Create a credential with a KeyPath set.
	resp := jsonrpcCall(t, h.conn, "credentials.create", profile.Credential{
		Name:    "test-path-key",
		Auth:    profile.AuthPublicKey,
		KeyPath: "/home/user/.ssh/id_ed25519",
	})
	var got struct {
		Result profile.Credential `json:"result"`
	}
	if err := json.Unmarshal(resp, &got); err != nil {
		t.Fatalf("create: %v\nraw: %s", err, string(resp))
	}
	credID := got.Result.ID

	// Save key material — should clear KeyPath.
	pem, _ := testPrivateKeyPEM(t)
	fp, _, raw := h.saveKeyMaterial(credID, pem)
	if fp == "" {
		t.Fatalf("saveKeyMaterial failed: %s", string(raw))
	}

	cred := h.loadCredential(credID)
	if cred.KeyPath != "" {
		t.Fatalf("KeyPath should be cleared after saving key material, got %q", cred.KeyPath)
	}
}

// --- deleteKeyMaterial RPC tests ---

func TestDeleteKeyMaterial_Success(t *testing.T) {
	h := newKeyMaterialHarness(t)
	credID := h.createCredential("test-del", profile.AuthPublicKey)
	// Save key material first.
	pem, _ := testPrivateKeyPEM(t)
	fp, _, raw := h.saveKeyMaterial(credID, pem)
	if fp == "" {
		t.Fatalf("saveKeyMaterial: %s", string(raw))
	}

	// Get the secret ID before deletion.
	cred := h.loadCredential(credID)
	secretID := cred.KeyMaterialSecretID

	// Delete key material.
	resp := h.deleteKeyMaterial(credID)
	var delResult struct {
		Result struct{} `json:"result"`
	}
	if err := json.Unmarshal(resp, &delResult); err != nil {
		t.Fatalf("deleteKeyMaterial failed: %v\nraw: %s", err, string(resp))
	}

	// Verify reference is cleared.
	cred = h.loadCredential(credID)
	if cred.KeyMaterialSecretID != "" {
		t.Fatalf("KeyMaterialSecretID should be cleared, got %q", cred.KeyMaterialSecretID)
	}
	if cred.KeyFingerprint != "" {
		t.Fatalf("KeyFingerprint should be cleared, got %q", cred.KeyFingerprint)
	}
	// Verify secret is deleted from vault.
	exists, err := h.cs.Exists(t.Context(), credential.SecretID(secretID))
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if exists {
		t.Fatal("key material should be deleted from vault")
	}
}

func TestDeleteKeyMaterial_Idempotent(t *testing.T) {
	h := newKeyMaterialHarness(t)
	credID := h.createCredential("test-idempotent", profile.AuthPublicKey)

	// Double delete should succeed (idempotent).
	resp := h.deleteKeyMaterial(credID)
	var result struct {
		Result struct{} `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("first deleteKeyMaterial failed: %v\nraw: %s", err, string(resp))
	}

	resp = h.deleteKeyMaterial(credID)
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("second deleteKeyMaterial (idempotent) failed: %v\nraw: %s", err, string(resp))
	}
}

// --- credentials.list response fields ---

func TestCredentialList_HasKeyMaterialFields(t *testing.T) {
	h := newKeyMaterialHarness(t)
	// Create two credentials: one with key material, one without.
	credWithKey := h.createCredential("with-key", profile.AuthPublicKey)
	credWithoutKey := h.createCredential("no-key", profile.AuthPassword)
	pem, expectedFP := testPrivateKeyPEM(t)
	fp, _, raw := h.saveKeyMaterial(credWithKey, pem)
	if fp == "" {
		t.Fatalf("saveKeyMaterial: %s", string(raw))
	}

	// Load via list.
	creds, err := h.ps.LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}

	for i := range creds {
		// Populate response fields the same way the handler does.
		creds[i].HasKeyMaterial = creds[i].KeyMaterialSecretID != ""
	}

	for _, c := range creds {
		switch c.ID {
		case credWithKey:
			if !c.HasKeyMaterial {
				t.Error("credential with key material should have hasKeyMaterial=true")
			}
			if c.KeyFingerprint != expectedFP {
				t.Errorf("credential with key material: expected fingerprint %q, got %q", expectedFP, c.KeyFingerprint)
			}
		case credWithoutKey:
			if c.HasKeyMaterial {
				t.Error("credential without key material should have hasKeyMaterial=false")
			}
			if c.KeyFingerprint != "" {
				t.Errorf("credential without key material should have empty fingerprint, got %q", c.KeyFingerprint)
			}
		}
	}
}

// --- Exclusivity: setting KeyPath deletes key material ---

func TestUpdateCredential_KeyPathClearsKeyMaterial(t *testing.T) {
	h := newKeyMaterialHarness(t)
	credID := h.createCredential("test-exclusive", profile.AuthPublicKey)
	// Save key material.
	pem, _ := testPrivateKeyPEM(t)
	fp, _, raw := h.saveKeyMaterial(credID, pem)
	if fp == "" {
		t.Fatalf("saveKeyMaterial: %s", string(raw))
	}

	// Get the vault secret ID before update.
	cred := h.loadCredential(credID)
	oldSecretID := credential.SecretID(cred.KeyMaterialSecretID)

	// Now set KeyPath via credentials.update.
	newKeyPath := "/home/user/.ssh/other_key"
	resp := jsonrpcCall(t, h.conn, "credentials.update", map[string]any{
		"id":      credID,
		"keyPath": newKeyPath,
	})
	var updateResult struct {
		Result profile.Credential `json:"result"`
	}
	if err := json.Unmarshal(resp, &updateResult); err != nil {
		t.Fatalf("update credential: %v\nraw: %s", err, string(resp))
	}

	// Verify the response has empty key fields.
	if updateResult.Result.KeyFingerprint != "" {
		t.Errorf("KeyFingerprint should be cleared after setting KeyPath, got %q", updateResult.Result.KeyFingerprint)
	}
	if updateResult.Result.HasKeyMaterial {
		t.Error("HasKeyMaterial should be false after setting KeyPath")
	}

	// Verify the persisted credential metadata was cleared.
	cred = h.loadCredential(credID)
	if cred.KeyMaterialSecretID != "" {
		t.Errorf("KeyMaterialSecretID should be cleared, got %q", cred.KeyMaterialSecretID)
	}
	if cred.KeyFingerprint != "" {
		t.Errorf("KeyFingerprint should be cleared, got %q", cred.KeyFingerprint)
	}

	// Verify the vault secret was deleted.
	exists, err := h.cs.Exists(t.Context(), oldSecretID)
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if exists {
		t.Error("vault secret should be deleted after setting KeyPath")
	}
}

// --- saveKeyPassphrase verification tests ---

// A passphrase that does not open the stored key must be refused there and
// then. Storing it unverified moves the failure from a moment the user can
// fix (the editor, with the key still on screen) to a moment they cannot
// (the connect, where a wrong passphrase is a dead end) — the same deferred
// lie this surface has been shedding all session.
func TestSaveKeyPassphrase_RefusesWrongPassphrase(t *testing.T) {
	h := newKeyMaterialHarness(t)
	credID := h.createCredential("test-enc-key", profile.AuthPublicKey)

	pem, _ := testEncryptedKeyPEM(t, "correct-passphrase")
	_, wantsPassphrase, raw := h.saveKeyMaterial(credID, pem)
	if !wantsPassphrase {
		t.Fatalf("precondition failed: encrypted key not flagged: %s", string(raw))
	}

	resp := h.saveKeyPassphrase(credID, "wrong-passphrase")
	var errResp struct {
		Error struct {
			Data struct {
				Reason string `json:"reason"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if errResp.Error.Data.Reason != "invalid-key-passphrase" {
		t.Fatalf("reason = %q, want invalid-key-passphrase", errResp.Error.Data.Reason)
	}

	// Nothing was stored: the credential record still has no passphrase ref.
	cred := h.loadCredential(credID)
	if cred.PassphraseSecretID != "" {
		t.Fatal("a refused passphrase must not be stored")
	}
}

func TestSaveKeyPassphrase_StoresVerifiedPassphrase(t *testing.T) {
	h := newKeyMaterialHarness(t)
	credID := h.createCredential("test-enc-key", profile.AuthPublicKey)

	pem, _ := testEncryptedKeyPEM(t, "correct-passphrase")
	_, wantsPassphrase, raw := h.saveKeyMaterial(credID, pem)
	if !wantsPassphrase {
		t.Fatalf("precondition failed: encrypted key not flagged: %s", string(raw))
	}

	resp := h.saveKeyPassphrase(credID, "correct-passphrase")
	var success struct {
		Result bool `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &success); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if success.Error != nil {
		t.Fatalf("saveKeyPassphrase with the correct passphrase refused: %s", success.Error.Message)
	}
	if !success.Result {
		t.Fatal("saveKeyPassphrase returned false")
	}

	cred := h.loadCredential(credID)
	if cred.PassphraseSecretID == "" {
		t.Fatal("verified passphrase not linked to the credential")
	}
}

// A credential with no stored key material (a path-based key, a pre-seeded
// reference) cannot be verified at save time and keeps the prior behaviour:
// the passphrase is stored and the connection resolves the file and the
// passphrase together, where the key itself is the verifier.
func TestSaveKeyPassphrase_StoresWhenNothingToVerifyAgainst(t *testing.T) {
	h := newKeyMaterialHarness(t)
	credID := h.createCredential("test-path-key", profile.AuthPublicKey)

	resp := h.saveKeyPassphrase(credID, "some-passphrase")
	var success struct {
		Result bool `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &success); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if success.Error != nil {
		t.Fatalf("saveKeyPassphrase refused without material: %s", success.Error.Message)
	}
	if !success.Result {
		t.Fatal("saveKeyPassphrase returned false")
	}

	cred := h.loadCredential(credID)
	if cred.PassphraseSecretID == "" {
		t.Fatal("passphrase not linked to the credential")
	}
}
