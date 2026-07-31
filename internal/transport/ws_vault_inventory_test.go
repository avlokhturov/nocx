package transport

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/storage"
	"github.com/shady2k/nocx/internal/vault"
	"github.com/shady2k/nocx/internal/vault/file"
)

// Test for vault.inventory RPC using a real vault + profile store.

type inventoryHarness struct {
	t    *testing.T
	v    *vault.Vault
	ps   *profile.JSONStore
	conn *websocket.Conn
}

func newInventoryHarness(t *testing.T) *inventoryHarness {
	t.Helper()
	dir := t.TempDir()
	docStore := storage.NewDocumentStore(dir)

	reg, err := vault.NewRegistry(file.New(docStore, "vault-blob.json"))
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	v, err := vault.New(docStore, reg, logger)
	if err != nil {
		t.Fatalf("vault.New: %v", err)
	}
	t.Cleanup(v.Close)

	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(v),
		WithVaultLifecycle(v))
	ctx := t.Context()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })

	return &inventoryHarness{t: t, v: v, ps: ps, conn: conn}
}

func (h *inventoryHarness) setupAndUnseal() {
	h.t.Helper()
	_, err := h.v.Setup(h.t.Context(), vault.SetupRequest{Passphrase: "test"})
	if err != nil {
		h.t.Fatalf("Setup: %v", err)
	}
}

func (h *inventoryHarness) createCredential(c profile.Credential) string {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "credentials.create", c)
	var result struct {
		Result profile.Credential `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		h.t.Fatalf("credentials.create unmarshal: %v\nraw: %s", err, string(resp))
	}
	return result.Result.ID
}

func (h *inventoryHarness) savePassword(credID, password string) {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "credentials.savePassword", map[string]any{
		"credentialId": credID,
		"password":     password,
	})
	var result struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		h.t.Fatalf("credentials.savePassword unmarshal: %v\nraw: %s", err, string(resp))
	}
	if !result.Result {
		h.t.Fatal("credentials.savePassword returned false")
	}
}

// savePasswordNamed saves a password the way the renderer does once the
// secret owns its name (ADR-0016): with the generated name attached.
func (h *inventoryHarness) savePasswordNamed(credID, password, name string) {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "credentials.savePassword", map[string]any{
		"credentialId": credID,
		"password":     password,
		"name":         name,
	})
	var result struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		h.t.Fatalf("credentials.savePassword unmarshal: %v\nraw: %s", err, string(resp))
	}
	if !result.Result {
		h.t.Fatal("credentials.savePassword returned false")
	}
}

func (h *inventoryHarness) savePassphrase(credID, passphrase string) {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "credentials.saveKeyPassphrase", map[string]any{
		"credentialId": credID,
		"passphrase":   passphrase,
	})
	var result struct {
		Result bool `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		h.t.Fatalf("credentials.saveKeyPassphrase unmarshal: %v\nraw: %s", err, string(resp))
	}
	if !result.Result {
		h.t.Fatal("credentials.saveKeyPassphrase returned false")
	}
}

func (h *inventoryHarness) createProfile(p profile.SSHProfile) {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "profiles.create", p)
	var result struct {
		Result profile.SSHProfile `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		h.t.Fatalf("profiles.create unmarshal: %v\nraw: %s", err, string(resp))
	}
}

type inventoryResponse struct {
	Entries []inventoryEntryDTO `json:"entries"`
}

type inventoryEntryDTO struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Provider  string `json:"provider"`
	OwnerID   string `json:"ownerId"`
	UsedBy    int    `json:"usedBy"`
	Reachable bool   `json:"reachable"`
}

func (h *inventoryHarness) callInventory() inventoryResponse {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "vault.inventory", map[string]any{})
	var result struct {
		Result inventoryResponse `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		h.t.Fatalf("vault.inventory unmarshal: %v\nraw: %s", err, string(resp))
	}
	return result.Result
}

func (h *inventoryHarness) callInventoryError() (int, string) {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, "vault.inventory", map[string]any{})
	var errResult struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &errResult); err != nil {
		h.t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if errResult.Error == nil {
		h.t.Fatal("expected error, got success")
	}
	return errResult.Error.Code, errResult.Error.Message
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestVaultInventory_MixedCredentials(t *testing.T) {
	h := newInventoryHarness(t)
	h.setupAndUnseal()

	idPass := h.createCredential(profile.Credential{
		Name: "prod", Username: "deploy", Auth: profile.AuthPassword,
	})
	h.savePassword(idPass, "hunter2")

	idKey := h.createCredential(profile.Credential{
		Name: "ops", Username: "opsuser", Auth: profile.AuthPublicKey,
	})
	h.savePassphrase(idKey, "pass123")

	// Three profiles referencing the password credential.
	user1 := "deploy"
	port22 := 22
	for i := range 3 {
		host := fmt.Sprintf("vm-dsm0%d", i+1)
		h.createProfile(profile.SSHProfile{
			Base: profile.Base{
				ID:   fmt.Sprintf("prof:pass:%d", i),
				Name: fmt.Sprintf("Production %d", i+1),
				Type: "ssh",
			},
			Options: profile.StoredSSHProfileOptions{
				Host:         host,
				Port:         &port22,
				CredentialID: idPass,
				User:         &user1,
			},
		})
	}

	// One profile referencing the key credential.
	user2 := "opsuser"
	port2222 := 2222
	h.createProfile(profile.SSHProfile{
		Base: profile.Base{
			ID:   "prof:key:1",
			Name: "OPS Server",
			Type: "ssh",
		},
		Options: profile.StoredSSHProfileOptions{
			Host:         "ops.internal",
			Port:         &port2222,
			CredentialID: idKey,
			User:         &user2,
		},
	})

	inv := h.callInventory()
	if len(inv.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(inv.Entries))
	}

	var passEntry, keyEntry *inventoryEntryDTO
	for i := range inv.Entries {
		e := &inv.Entries[i]
		switch e.Kind {
		case "password":
			passEntry = e
		case "key-passphrase":
			keyEntry = e
		}
	}

	if passEntry == nil {
		t.Fatal("no password entry found")
	}
	if passEntry.Kind != "password" {
		t.Errorf("password kind = %q, want %q", passEntry.Kind, "password")
	}
	if passEntry.Provider == "" {
		t.Error("password provider is empty")
	}
	if passEntry.UsedBy != 3 {
		t.Errorf("password usedBy = %d, want 3", passEntry.UsedBy)
	}
	if !passEntry.Reachable {
		t.Error("password reachable should be true")
	}
	if passEntry.Name != "SSH password for deploy" {
		t.Errorf("password name = %q, want %q", passEntry.Name, "SSH password for deploy")
	}

	if keyEntry == nil {
		t.Fatal("no key-passphrase entry found")
	}
	if keyEntry.Kind != "key-passphrase" {
		t.Errorf("key kind = %q, want %q", keyEntry.Kind, "key-passphrase")
	}
	if !keyEntry.Reachable {
		t.Error("key reachable should be true")
	}
	if keyEntry.UsedBy != 1 {
		t.Errorf("key usedBy = %d, want 1", keyEntry.UsedBy)
	}
	// KeyFingerprint is not populated by saveKeyPassphrase; label shows
	// "SHA256:…" with an empty fingerprint — a known data gap in writer.
	if keyEntry.Name != "Passphrase for key SHA256:…" {
		t.Errorf("key name = %q, want %q", keyEntry.Name, "Passphrase for key SHA256:…")
	}
}

func TestVaultInventory_SealedVault(t *testing.T) {
	h := newInventoryHarness(t)
	h.setupAndUnseal()

	idA := h.createCredential(profile.Credential{
		Name: "prod", Username: "deploy", Auth: profile.AuthPassword,
	})
	h.savePassword(idA, "hunter2")

	h.v.Seal()

	code, msg := h.callInventoryError()
	if code != -32001 {
		t.Errorf("error code = %d, want -32001 (ErrVaultSealed)", code)
	}
	if msg == "" {
		t.Error("expected non-empty error message for sealed vault")
	}
}

func TestVaultInventory_UninitializedVault(t *testing.T) {
	h := newInventoryHarness(t)

	code, msg := h.callInventoryError()
	if code != -32000 {
		t.Errorf("error code = %d, want -32000 (ErrVaultUninitialized)", code)
	}
	if msg == "" {
		t.Error("expected non-empty error message")
	}
}

func TestVaultInventory_EmptyStore(t *testing.T) {
	h := newInventoryHarness(t)
	h.setupAndUnseal()

	inv := h.callInventory()
	if len(inv.Entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(inv.Entries))
	}
}

func TestVaultInventory_NotWired(t *testing.T) {
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)))
	ctx := t.Context()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })

	resp := jsonrpcCall(t, conn, "vault.inventory", map[string]any{})
	var errResult struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &errResult); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if errResult.Error == nil {
		t.Fatal("expected error for unwired vault")
	}
	if errResult.Error.Code != -32601 {
		t.Errorf("error code = %d, want -32601", errResult.Error.Code)
	}
}

// A secret created through the production save path survives a restart.
// The journal contract used to be test-only: production never calls
// AttachTarget/CommitMetadata, so a PhaseSecretWritten entry with an empty
// target was deleted by Reconcile at the next startup. The catalogue record
// (ADR-0016) is the durable proof: the entry is cleared, the secret kept,
// and the row still renders with its name.
func TestVaultInventory_SecretSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	docStore := storage.NewDocumentStore(dir)
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))

	newVault := func() (*vault.Vault, func()) {
		reg, err := vault.NewRegistry(file.New(docStore, "vault-blob.json"))
		if err != nil {
			t.Fatalf("NewRegistry: %v", err)
		}
		v, err := vault.New(docStore, reg, logger)
		if err != nil {
			t.Fatalf("vault.New: %v", err)
		}
		return v, v.Close
	}

	v, closeV := newVault()
	if _, err := v.Setup(t.Context(), vault.SetupRequest{Passphrase: "test"}); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	id, err := v.CreateNamed(t.Context(), credential.NewSecret("hunter2"),
		vault.SecretMeta{Name: "deploy@web.example.com", Kind: vault.KindPassword})
	if err != nil {
		t.Fatalf("CreateNamed: %v", err)
	}
	closeV()

	// Restart: reconciliation runs, the record proves the secret exists.
	v2, closeV2 := newVault()
	defer closeV2()
	if unsealErr := v2.Unseal(t.Context(), vault.UnsealRequest{Passphrase: "test"}); unsealErr != nil {
		t.Fatalf("Unseal after restart: %v", unsealErr)
	}
	ok, err := v2.Exists(t.Context(), id)
	if err != nil {
		t.Fatalf("Exists after restart: %v", err)
	}
	if !ok {
		t.Fatal("secret was deleted by reconciliation at startup")
	}
	entries, err := v2.BuildInventory(t.Context(), nil)
	if err != nil {
		t.Fatalf("BuildInventory after restart: %v", err)
	}
	if len(entries) != 1 || entries[0].Name != "deploy@web.example.com" {
		t.Fatalf("inventory after restart = %+v, want the named ownerless row", entries)
	}
}
