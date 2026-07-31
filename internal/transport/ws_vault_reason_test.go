package transport

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/storage"
	"github.com/shady2k/nocx/internal/vault"
	"github.com/shady2k/nocx/internal/vault/file"
)

// A password saved from the connection form does not go through vault.*. It
// goes through credentials.savePassword, which predates the vault, and those
// handlers used to wrap the vault's sentinel in a bare -32603. The renderer
// decides between "open the setup dialog" and "show a failure" by reading
// error.data.reason, so a missing reason means the user is told the save
// failed and is offered nothing — which is precisely what shipped, past a
// green frontend suite whose fakes rejected with a reason already attached
// (nocx-25k9.7).
//
// These tests drive a real *vault.Vault, not a stub returning a hand-picked
// error, because the defect lived in the distance between what the vault
// returns and what the wire carries.

// vaultReasonHarness wires a WSServer whose credential store IS the vault.
type vaultReasonHarness struct {
	t     *testing.T
	v     *vault.Vault
	ps    *profile.JSONStore
	conn  *websocket.Conn
	credA string
}

func newVaultReasonHarness(t *testing.T) *vaultReasonHarness {
	t.Helper()
	dir := t.TempDir()
	docStore := storage.NewDocumentStore(dir)

	// Only the file provider: no keychain on CI, and setup by passphrase
	// keeps the test independent of the host's Secret Service.
	reg, err := vault.NewRegistry(file.New(docStore, "vault-blob.json"))
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	v, err := vault.New(docStore, reg, logger)
	if err != nil {
		t.Fatalf("vault.New: %v", err)
	}

	ps := profile.NewJSONStore(dir + "/p.json")
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(v))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = ws.Stop(ctx) })
	conn := connectWS(t, ws)
	t.Cleanup(func() { _ = conn.Close() })

	h := &vaultReasonHarness{t: t, v: v, ps: ps, conn: conn}

	// Creating a credential touches metadata only, so it succeeds against an
	// uninitialized vault — which is exactly how a user arrives here.
	resp := jsonrpcCall(t, conn, "credentials.create", profile.Credential{
		Name: "prod", Username: "root", Auth: "password",
	})
	var created struct {
		Result profile.Credential `json:"result"`
	}
	if err := json.Unmarshal(resp, &created); err != nil || created.Result.ID == "" {
		t.Fatalf("credentials.create: %v\nraw: %s", err, string(resp))
	}
	h.credA = created.Result.ID
	return h
}

// reasonOf calls the method and returns error.data.reason, failing the test if
// the call succeeded or the error carried no reason at all.
func (h *vaultReasonHarness) reasonOf(method string, params map[string]any) string {
	h.t.Helper()
	resp := jsonrpcCall(h.t, h.conn, method, params)
	var got struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Data    *struct {
				Reason string `json:"reason"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &got); err != nil {
		h.t.Fatalf("%s: unmarshal: %v\nraw: %s", method, err, string(resp))
	}
	if got.Error == nil {
		h.t.Fatalf("%s: expected an error against a locked vault, got: %s", method, string(resp))
	}
	if got.Error.Data == nil {
		h.t.Fatalf("%s: error carries no data.reason, so the renderer cannot tell "+
			"a vault that needs setting up from a disk failure: %s", method, string(resp))
	}
	return got.Error.Data.Reason
}

// the two write paths a user can reach from the connection and credential
// forms. Each one calls SecretStore.Create under the hood.
func (h *vaultReasonHarness) writePaths() map[string]map[string]any {
	return map[string]map[string]any{
		"credentials.savePassword": {
			"credentialId": h.credA, "password": "hunter2",
		},
		"credentials.saveKeyPassphrase": {
			"credentialId": h.credA, "passphrase": "hunter2",
		},
	}
}

func TestCredentialWrites_UninitializedVault_CarryReason(t *testing.T) {
	h := newVaultReasonHarness(t)
	for method, params := range h.writePaths() {
		t.Run(method, func(t *testing.T) {
			if got := h.reasonOf(method, params); got != "vault-uninitialized" {
				t.Fatalf("%s: reason = %q, want %q", method, got, "vault-uninitialized")
			}
		})
	}
}

func TestCredentialWrites_SealedVault_CarryReason(t *testing.T) {
	h := newVaultReasonHarness(t)
	if _, err := h.v.Setup(context.Background(), vault.SetupRequest{Passphrase: "correct horse"}); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	h.v.Seal()

	for method, params := range h.writePaths() {
		t.Run(method, func(t *testing.T) {
			if got := h.reasonOf(method, params); got != "vault-sealed" {
				t.Fatalf("%s: reason = %q, want %q", method, got, "vault-sealed")
			}
		})
	}
}

// The reason survives an unsealed vault too — that is, a genuine failure with
// no vault cause must NOT be dressed up as one, or the renderer opens a setup
// dialog for a disk error.
func TestCredentialWrites_UnsealedVault_NoSpuriousReason(t *testing.T) {
	h := newVaultReasonHarness(t)
	if _, err := h.v.Setup(context.Background(), vault.SetupRequest{Passphrase: "correct horse"}); err != nil {
		t.Fatalf("Setup: %v", err)
	}

	resp := jsonrpcCall(t, h.conn, "credentials.savePassword", map[string]any{
		"credentialId": "no-such-credential",
		"password":     "hunter2",
	})
	var got struct {
		Error *struct {
			Data *struct {
				Reason string `json:"reason"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &got); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if got.Error == nil {
		t.Fatalf("expected an error for an unknown credential: %s", string(resp))
	}
	if got.Error.Data != nil {
		t.Fatalf("a missing credential is not a vault problem, but the error claims "+
			"reason %q: %s", got.Error.Data.Reason, string(resp))
	}
}
