package transport

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/zalando/go-keyring"
)

// These tests prove the credential delete cascade (nocx-7l4): deleting a
// credential removes its metadata AND every secret it references, in an
// order that cannot strand a secret. They query the secret store directly,
// never through the RPC being changed, so a regression in the cascade is
// caught even if the RPC lies about success.

// cascadeHarness wires a WSServer with a profile store and a keychain
// credential store, ready for delete-cascade tests. The keyring mock is
// per-test fresh.
type cascadeHarness struct {
	t      *testing.T
	ws     *WSServer
	ps     *profile.JSONStore
	cs     *credential.Keychain
	conn   *websocket.Conn
	keyDir string
}

func newCascadeHarness(t *testing.T) *cascadeHarness {
	t.Helper()
	keyring.MockInit()
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	cs := credential.NewKeychain()
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileStore(ps), WithCredentialStore(cs))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })
	return &cascadeHarness{t: t, ws: ws, ps: ps, cs: cs, conn: conn, keyDir: dir}
}

// createCredentialViaRPC creates a credential through the credentials.create
// RPC and returns the server-assigned ID. The ID is never hardcoded — it
// comes from the real NewCredentialID path the production UI uses.
func (h *cascadeHarness) createCredentialViaRPC(c profile.Credential) string {
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

func (h *cascadeHarness) deleteCredentialViaRPC(id string) {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "credentials.delete", map[string]any{"id": id})
	var got struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &got); err != nil {
		h.t.Fatalf("delete unmarshal: %v\nraw: %s", err, string(resp))
	}
	if !got.Result {
		h.t.Fatalf("delete returned false: %s", string(resp))
	}
}

// TestDeleteCascade_RemovesPassword proves deleting a credential removes
// the stored password from the secret store. It queries the keychain
// directly, not through the RPC under test.
func TestDeleteCascade_RemovesPassword(t *testing.T) {
	h := newCascadeHarness(t)

	id := h.createCredentialViaRPC(profile.Credential{
		Name: "cascade-pw", Username: "alice", Auth: "password",
	})

	const pw = "cascade-password-secret"
	if err := h.cs.SavePassword(credential.Identity{User: id}, pw); err != nil {
		t.Fatalf("SavePassword: %v", err)
	}
	if has, _ := h.cs.HasPassword(credential.Identity{User: id}); !has {
		t.Fatal("precondition: password should be present")
	}

	h.deleteCredentialViaRPC(id)

	if has, _ := h.cs.HasPassword(credential.Identity{User: id}); has {
		t.Fatal("password entry survived credential delete; the keychain is orphaned")
	}
}

// TestDeleteCascade_RemovesKeyPassphrase proves deleting a credential with a
// referenced private key removes the key passphrase entry. This is the
// ordering trap: the passphrase keys on KeyHash (derived from the key file),
// not the credential ID, so the metadata must be loaded BEFORE deletion to
// recover KeyPath. A naive delete-metadata-first implementation cannot
// remove this entry.
func TestDeleteCascade_RemovesKeyPassphrase(t *testing.T) {
	h := newCascadeHarness(t)

	// Write a real key file so the backend can read it and derive the hash.
	keyContents := []byte("-----BEGIN OPENSSH PRIVATE KEY-----\npretend\n-----END OPENSSH PRIVATE KEY-----\n")
	keyPath := filepath.Join(h.keyDir, "id_ed25519")
	if err := os.WriteFile(keyPath, keyContents, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	id := h.createCredentialViaRPC(profile.Credential{
		Name: "cascade-key", Username: "bob", Auth: "publicKey", KeyPath: keyPath,
	})

	// Save a passphrase under the hash the backend will re-derive from KeyPath.
	hash := credential.HashKey(keyContents)
	const pp = "cascade-passphrase-secret"
	if err := h.cs.SaveKeyPassphrase(hash, pp); err != nil {
		t.Fatalf("SaveKeyPassphrase: %v", err)
	}
	got, err := h.cs.LookupKeyPassphrase(hash)
	if err != nil || got.IsEmpty() {
		t.Fatalf("precondition: passphrase should be present, got %v", err)
	}

	h.deleteCredentialViaRPC(id)

	after, err := h.cs.LookupKeyPassphrase(hash)
	if err != nil {
		t.Fatalf("LookupKeyPassphrase after delete: %v", err)
	}
	if !after.IsEmpty() {
		t.Fatal("key passphrase survived credential delete; the secret is orphaned forever")
	}
}

// TestDeleteCascade_NoSecretsSucceeds proves deleting a credential that
// never had a secret stored succeeds. "Already absent" and "deleted" must
// converge.
func TestDeleteCascade_NoSecretsSucceeds(t *testing.T) {
	h := newCascadeHarness(t)

	id := h.createCredentialViaRPC(profile.Credential{
		Name: "cascade-empty", Username: "carol", Auth: "password",
	})

	// No password, no passphrase saved.
	h.deleteCredentialViaRPC(id)

	// And the metadata is gone too.
	creds, err := h.ps.LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	for _, c := range creds {
		if c.ID == id {
			t.Fatal("credential metadata survived delete")
		}
	}
}

// TestDeleteCascade_Idempotent proves deleting a credential twice both
// succeeds. A missing credential and a missing secret are not errors.
func TestDeleteCascade_Idempotent(t *testing.T) {
	h := newCascadeHarness(t)

	id := h.createCredentialViaRPC(profile.Credential{
		Name: "cascade-idem", Username: "dan", Auth: "password",
	})
	if err := h.cs.SavePassword(credential.Identity{User: id}, "p"); err != nil {
		t.Fatalf("SavePassword: %v", err)
	}

	h.deleteCredentialViaRPC(id)
	// Second delete: credential already gone, no secrets. Must still succeed.
	h.deleteCredentialViaRPC(id)

	if has, _ := h.cs.HasPassword(credential.Identity{User: id}); has {
		t.Fatal("password survived second delete")
	}
}
