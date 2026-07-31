package transport

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
)

// TestCredentialsRPC_UpdatePreservesSecretRefs is the regression that names
// wave 1 of the connection-manager redesign (nocx-ec2u).
//
// credentials.list blanks SecretID and PassphraseSecretID before answering the
// renderer, which is correct — ADR-0011 §2 makes the absence of any
// secret-returning API the boundary, not a redaction convention. The update
// handler then decoded the renderer's payload straight into profile.Credential
// and handed the whole record to SaveCredential, which replaces the stored row.
// So the blanks the renderer never saw were written back over the real ones: a
// rename left the keychain entry in place with nothing pointing at it, and the
// delete cascade could no longer reach it either, because the cascade finds
// secrets *through* the metadata that had just lost their IDs.
//
// The assertions deliberately read the store and the secret store directly
// rather than through the RPC under test, so a handler that lies about success
// still fails here.
func TestCredentialsRPC_UpdatePreservesSecretRefs(t *testing.T) {
	h := newCascadeHarness(t)

	id := h.createCredentialViaRPC(profile.Credential{
		Name:     "prod-ops",
		Username: "ops",
		Auth:     profile.AuthPassword,
	})

	pwID := h.savePasswordViaRPC(id, "s3cret")
	ppID := h.savePassphraseViaRPC(id, "key-phrase")
	if pwID == "" || ppID == "" {
		t.Fatalf("precondition failed: SecretID=%q PassphraseSecretID=%q", pwID, ppID)
	}

	// Exactly what the renderer sends when the user edits the name: no secret
	// references, because credentials.list never gave it any.
	jsonrpcCall(t, h.conn, "credentials.update", map[string]any{
		"id":       id,
		"name":     "prod-ops-renamed",
		"username": "ops",
		"auth":     "password",
		"host":     "10.0.0.1",
	})

	creds, err := h.ps.LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	var got profile.Credential
	for _, c := range creds {
		if c.ID == id {
			got = c
		}
	}
	if got.ID == "" {
		t.Fatalf("credential %s disappeared after update", id)
	}

	if got.Name != "prod-ops-renamed" {
		t.Errorf("Name = %q, want prod-ops-renamed", got.Name)
	}
	if got.SecretID != string(pwID) {
		t.Errorf("SecretID = %q, want %q — the update orphaned the stored password",
			got.SecretID, pwID)
	}
	if got.PassphraseSecretID != string(ppID) {
		t.Errorf("PassphraseSecretID = %q, want %q — the update orphaned the passphrase",
			got.PassphraseSecretID, ppID)
	}

	// The secrets themselves are untouched either way; the defect is that
	// nothing points at them any more. Assert they are still there, so a
	// future "fix" that deletes them instead of preserving the reference is
	// caught as the different bug it would be.
	if ok, err := h.cs.Exists(context.Background(), pwID); err != nil || !ok {
		t.Errorf("password secret %q missing after update (err=%v)", pwID, err)
	}
	if ok, err := h.cs.Exists(context.Background(), ppID); err != nil || !ok {
		t.Errorf("passphrase secret %q missing after update (err=%v)", ppID, err)
	}
}

func TestCredentialsRPC_CreateMintsItsOwnID(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(dir + "/p.json")
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "credentials.create", map[string]any{
		"id":       "cred:p:whatever-the-renderer-guessed",
		"name":     "prod-ops",
		"username": "ops",
		"auth":     "password",
		"host":     "10.0.0.1",
	})
	var out struct {
		Result profile.Credential `json:"result"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Result.ID == "cred:p:whatever-the-renderer-guessed" {
		t.Error("create used the renderer's ID; the backend must mint its own")
	}
	if !strings.HasPrefix(out.Result.ID, "cred:prod-ops:") {
		t.Errorf("ID = %q, want a cred:prod-ops: prefix from the final name", out.Result.ID)
	}
	if out.Result.SecretID != "" || out.Result.PassphraseSecretID != "" {
		t.Error("response leaked a secret reference")
	}
}

func TestCredentialsRPC_UpdateRequiresID(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(dir + "/p.json")
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	resp := jsonrpcCall(t, conn, "credentials.update", map[string]any{"name": "x"})
	var out struct {
		Error *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Error == nil || out.Error.Code != -32602 {
		t.Fatalf("want -32602 Invalid params, got %+v", out.Error)
	}
}
