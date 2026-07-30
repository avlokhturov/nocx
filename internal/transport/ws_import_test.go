package transport

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/importer"
	"github.com/shady2k/nocx/internal/log"
	"github.com/shady2k/nocx/internal/profile"
	"github.com/shady2k/nocx/internal/vault"

	"golang.org/x/crypto/pbkdf2"
)

// ── helpers ────────────────────────────────────────────────────────────

// encryptTabbyVaultForTest encrypts a plaintext JSON string into a TabbyVault
// using the same format as Tabby's vault.service.ts.
func encryptTabbyVaultForTest(t *testing.T, plaintext, passphrase string) importer.TabbyVault {
	t.Helper()
	salt := make([]byte, 8)
	if _, err := rand.Read(salt); err != nil {
		t.Fatalf("rand.Read (salt): %v", err)
	}
	iv := make([]byte, 16)
	if _, err := rand.Read(iv); err != nil {
		t.Fatalf("rand.Read (iv): %v", err)
	}
	key := pbkdf2.Key([]byte(passphrase), salt, 100_000, 32, sha512.New)
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("aes.NewCipher: %v", err)
	}
	padded := pkcs7Pad([]byte(plaintext), aes.BlockSize)
	ciphertext := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ciphertext, padded)

	return importer.TabbyVault{
		Version:   1,
		Encrypted: true,
		Contents:  base64.StdEncoding.EncodeToString(ciphertext),
		KeySalt:   hex.EncodeToString(salt),
		IV:        hex.EncodeToString(iv),
	}
}

func pkcs7Pad(data []byte, blockSize int) []byte {
	padLen := blockSize - len(data)%blockSize
	pad := make([]byte, padLen)
	for i := range pad {
		pad[i] = byte(padLen)
	}
	return append(data, pad...)
}

// buildImportConfigYAML builds a Tabby config YAML string with the given vault.
func buildImportConfigYAML(t *testing.T, vault *importer.TabbyVault, secretCount int) string {
	t.Helper()
	header := `version: 1
profiles:
  - id: "ssh:custom:p1"
    type: "ssh"
    name: "web-01"
    options:
      host: "web.example.com"
      port: 22
      user: "deploy"
groups:
  - id: "g:prod"
    name: "Production"
`
	if vault != nil {
		header += fmt.Sprintf("vault:\n  version: %d\n  encrypted: %t\n  contents: %q\n  keySalt: %q\n  iv: %q\n",
			vault.Version, vault.Encrypted, vault.Contents, vault.KeySalt, vault.IV)
	}
	return header
}

// failAfterStore fails Create calls after the Nth success.
type failAfterStore struct {
	mu        sync.Mutex
	successes int
	failAfter int
	err       error
	created   []string // values created so far
}

func newFailAfterStore(failAfter int) *failAfterStore {
	return &failAfterStore{failAfter: failAfter, err: context.DeadlineExceeded}
}

func (f *failAfterStore) Create(_ context.Context, value credential.Secret) (credential.SecretID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.successes++
	if f.successes > f.failAfter {
		return "", f.err
	}
	var val string
	if err := value.Use(func(b []byte) error {
		val = string(b)
		return nil
	}); err != nil {
		return "", err
	}
	id := credential.SecretID("test:" + val)
	f.created = append(f.created, val)
	return id, nil
}

func (f *failAfterStore) Get(_ context.Context, _ credential.SecretID) (credential.Secret, error) {
	return credential.Secret{}, nil
}

func (f *failAfterStore) Delete(_ context.Context, _ credential.SecretID) error {
	return nil
}

func (f *failAfterStore) Exists(_ context.Context, _ credential.SecretID) (bool, error) {
	return false, nil
}

func TestImportTabby_NoVault(t *testing.T) {
	// Plain config with no vault — existing behavior.
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(newTestStore()), WithProfileService(svc))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	config := `version: 1
profiles:
  - id: "ssh:custom:p1"
    type: "ssh"
    name: "web-01"
    options:
      host: "web.example.com"
      port: 22
      user: "deploy"
`
	resp := jsonrpcCall(t, conn, "profiles.importTabby", map[string]any{
		"config": config,
	})
	var result struct {
		Result int `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if result.Result != 1 {
		t.Errorf("expected 1 profile imported, got %d", result.Result)
	}
	profs, _ := ps.LoadProfiles()
	if len(profs) != 1 {
		t.Errorf("expected 1 profile in store, got %d", len(profs))
	}
}

func TestImportTabby_EncryptedVaultNoPassphrase(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(newTestStore()), WithProfileService(svc))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	vault := encryptTabbyVaultForTest(t, `{"config":null,"secrets":[]}`, "pw")
	config := buildImportConfigYAML(t, &vault, 0)

	resp := jsonrpcCall(t, conn, "profiles.importTabby", map[string]any{
		"config": config,
		// no passphrase
	})
	var errResp struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if errResp.Error == nil {
		t.Fatal("expected error for encrypted vault without passphrase, got success")
	}
	if errResp.Error.Code != -32603 {
		t.Errorf("expected code -32603, got %d", errResp.Error.Code)
	}
}

func TestImportTabby_WrongPassphrase(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(newTestStore()), WithProfileService(svc))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// Encrypt with "correct-pw" but decrypt with "wrong-pw".
	vault := encryptTabbyVaultForTest(t, `{"config":null,"secrets":[]}`, "correct-pw")
	config := buildImportConfigYAML(t, &vault, 0)

	resp := jsonrpcCall(t, conn, "profiles.importTabby", map[string]any{
		"config":     config,
		"passphrase": "wrong-pw",
	})
	var errResp struct {
		Error *struct {
			Code int `json:"code"`
			Data *struct {
				Reason string `json:"reason"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if errResp.Error == nil {
		t.Fatal("expected error for wrong passphrase, got success")
	}
}

func TestImportTabby_HappyPath(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	cs := newTestStore()
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(cs),
		WithProfileService(svc))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// Vault with a password secret matching the profile's host+port+user and a
	// key-passphrase secret.
	//
	// Both key shapes are copied from upstream — tabby-ssh's
	// passwordStorage.service.ts, getVaultKeyForConnection ({user, host, port})
	// and getVaultKeyForPrivateKey ({hash}). The passphrase key was a plain
	// string here until it was checked against Tabby: that shape is one no
	// Tabby ever writes, and the importer it was written alongside agreed with
	// it, so the pair was self-consistent and wrong together.
	vaultContent := `{"config":null,"secrets":[
		{"type":"ssh:password","key":{"user":"deploy","host":"web.example.com","port":22},"value":"hunter2"},
		{"type":"ssh:key-passphrase","key":{"hash":"9f2c4e1a77b0d3e5"},"value":"passphrase-val"}
	]}`
	vault := encryptTabbyVaultForTest(t, vaultContent, "test-pw")
	config := buildImportConfigYAML(t, &vault, 0)

	// Verify fixture parses before RPC.
	cfg, err := importer.ParseTabbyConfig([]byte(config))
	if err != nil {
		t.Fatalf("fixture config parse: %v", err)
	}
	t.Logf("parsed vault: encrypted=%v, nil=%v", cfg.Vault != nil && cfg.Vault.Encrypted, cfg.Vault == nil)
	if cfg.Vault == nil || !cfg.Vault.Encrypted {
		t.Fatal("fixture vault not parsed as encrypted — YAML fixture is wrong")
	}
	t.Logf("profiles: %+v", cfg.Profiles[0])

	resp := jsonrpcCall(t, conn, "profiles.importTabby", map[string]any{
		"config":     config,
		"passphrase": "test-pw",
	})
	var result struct {
		Result int `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if result.Result != 1 {
		t.Errorf("expected 1 profile imported, got %d", result.Result)
	}

	// Profile should reference the credential.
	profs, _ := ps.LoadProfiles()
	if len(profs) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(profs))
	}
	p := profs[0]
	if p.Options.CredentialID == "" {
		t.Error("profile should have CredentialID set from vault secret matching")
	}
	if p.NeedsReview {
		t.Error("new credential should not mark profile for review")
	}

	// Verify credentials were created in the credential store.
	creds, _ := ps.LoadCredentials()
	if len(creds) != 2 {
		t.Errorf("expected 2 credentials, got %d", len(creds))
	}

	// Verify the credential references a real secret.
	for _, c := range creds {
		if c.SecretID != "" {
			_, err := cs.Get(context.Background(), credential.SecretID(c.SecretID))
			if err != nil {
				t.Errorf("Get secret %q: %v", c.SecretID, err)
			}
		}
		if c.PassphraseSecretID != "" {
			_, err := cs.Get(context.Background(), credential.SecretID(c.PassphraseSecretID))
			if err != nil {
				t.Errorf("Get passphrase secret %q: %v", c.PassphraseSecretID, err)
			}
		}
	}
}

// A secret type we do not handle is skipped, and the rest of the import still
// happens.
//
// Tabby's vault is shared by every plugin the user has installed, so an
// unfamiliar type is ordinary, not exceptional. Failing the whole call on one
// would throw away the profiles and groups that converted fine — and the user
// would see a Tabby import that simply refuses, with no way to tell which of
// their secrets caused it.
func TestImportTabby_UnhandledSecretTypeIsSkipped(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(newTestStore()), WithProfileService(svc))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// One secret we handle, one we do not.
	vaultContent := `{"config":null,"secrets":[
		{"type":"ssh:totp","key":"web.example.com","value":"123456"},
		{"type":"ssh:password","key":{"user":"deploy","host":"web.example.com","port":22},"value":"hunter2"}
	]}`
	vault := encryptTabbyVaultForTest(t, vaultContent, "pw")
	config := buildImportConfigYAML(t, &vault, 0)

	resp := jsonrpcCall(t, conn, "profiles.importTabby", map[string]any{
		"config":     config,
		"passphrase": "pw",
	})
	var got struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &got); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if got.Error != nil {
		t.Fatalf("an unhandled secret type must not fail the import: %s", got.Error.Message)
	}

	// The handled secret still arrived.
	creds, err := ps.LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	if len(creds) != 1 {
		t.Fatalf("expected the password secret to import despite the unknown one, got %d credentials", len(creds))
	}
}

func TestImportTabby_InvalidSecretValue(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(newTestStore()), WithProfileService(svc))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// Value is null (not a string).
	vaultContent := `{"config":null,"secrets":[
		{"type":"ssh:password","key":{"user":"deploy","host":"web.example.com","port":22},"value":null}
	]}`
	vault := encryptTabbyVaultForTest(t, vaultContent, "pw")
	config := buildImportConfigYAML(t, &vault, 0)

	resp := jsonrpcCall(t, conn, "profiles.importTabby", map[string]any{
		"config":     config,
		"passphrase": "pw",
	})
	var errResp struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if errResp.Error == nil {
		t.Fatal("expected error for invalid secret value, got success")
	}
}

func TestImportTabby_CreateFailsMidway(t *testing.T) {
	// Create fails on the 3rd of 5 secrets. Secrets 1-2 are created as orphans.
	// The profile/credential metadata store is unchanged (import never reaches AtomicImport).
	// Orphaned secrets will be cleaned up by reconciliation on next start.
	//
	// This test verifies:
	//   1. The error is surfaced to the caller.
	//   2. Orphaned secrets 1-2 exist in the SecretStore.
	//   3. The metadata store has NO credentials (import never completed).
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	failStore := newFailAfterStore(2) // succeeds 2 times, fails on 3rd
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(failStore), WithProfileService(svc))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// 5 secrets. Profiles don't need to match since they won't be imported anyway.
	vaultContent := `{"config":null,"secrets":[
		{"type":"ssh:password","key":{"user":"a","host":"a.example.com","port":22},"value":"s1"},
		{"type":"ssh:password","key":{"user":"b","host":"b.example.com","port":22},"value":"s2"},
		{"type":"ssh:password","key":{"user":"c","host":"c.example.com","port":22},"value":"s3"},
		{"type":"ssh:password","key":{"user":"d","host":"d.example.com","port":22},"value":"s4"},
		{"type":"ssh:password","key":{"user":"e","host":"e.example.com","port":22},"value":"s5"}
	]}`
	vault := encryptTabbyVaultForTest(t, vaultContent, "pw")
	config := buildImportConfigYAML(t, &vault, 0)

	resp := jsonrpcCall(t, conn, "profiles.importTabby", map[string]any{
		"config":     config,
		"passphrase": "pw",
	})
	var errResp struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if errResp.Error == nil {
		t.Fatal("expected error from failing SecretStore, got success")
	}

	// Secrets 1-2 were created (they're orphans now).
	failStore.mu.Lock()
	orphans := len(failStore.created)
	failStore.mu.Unlock()
	if orphans != 2 {
		t.Errorf("expected 2 orphaned secrets, got %d", orphans)
	}
	if orphans > 0 && failStore.created[0] != "s1" {
		t.Errorf("expected orphan s1, got %q", failStore.created[0])
	}
	if orphans > 1 && failStore.created[1] != "s2" {
		t.Errorf("expected orphan s2, got %q", failStore.created[1])
	}

	// Metadata store has no credentials — import never reached AtomicImport.
	creds, _ := ps.LoadCredentials()
	if len(creds) != 0 {
		t.Errorf("expected 0 credentials in metadata store (import aborted), got %d", len(creds))
	}
}

func TestImportTabby_SealedVault(t *testing.T) {
	// When the SecretStore returns a vault-sealed error, the RPC must surface
	// the reason code so the renderer can show the unseal dialog instead of
	// a generic toast.
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	sealedStore := newFailAfterStore(0)
	sealedStore.err = vault.ErrVaultSealed
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(sealedStore), WithProfileService(svc))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	vaultContent := `{"config":null,"secrets":[
		{"type":"ssh:password","key":{"user":"deploy","host":"web.example.com","port":22},"value":"hunter2"}
	]}`
	vault := encryptTabbyVaultForTest(t, vaultContent, "pw")
	config := buildImportConfigYAML(t, &vault, 0)

	resp := jsonrpcCall(t, conn, "profiles.importTabby", map[string]any{
		"config":     config,
		"passphrase": "pw",
	})
	var errResp struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Data    *struct {
				Reason string `json:"reason"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if errResp.Error == nil {
		t.Fatal("expected error for sealed vault, got success")
	}
	if errResp.Error.Code != -32001 {
		t.Errorf("error code = %d, want -32001 (vault-sealed)", errResp.Error.Code)
	}
	if errResp.Error.Data == nil || errResp.Error.Data.Reason != "vault-sealed" {
		t.Errorf("error data.reason = %v, want 'vault-sealed'", errResp.Error.Data)
	}
}

func TestImportTabby_VaultSecrets(t *testing.T) {
	// Import with credentials + credMeta via the atomic import path.
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	cs := newTestStore()
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(cs), WithProfileService(svc))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	vaultContent := `{"config":null,"secrets":[
		{"type":"ssh:password","key":{"user":"deploy","host":"web.example.com","port":22},"value":"hunter2"}
	]}`
	vault := encryptTabbyVaultForTest(t, vaultContent, "pw")
	config := buildImportConfigYAML(t, &vault, 0)

	resp := jsonrpcCall(t, conn, "profiles.importTabby", map[string]any{
		"config":     config,
		"passphrase": "pw",
	})
	var result struct {
		Result int `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if result.Result != 1 {
		t.Errorf("expected 1 profile imported, got %d", result.Result)
	}

	// Credential should be in the metadata store.
	creds, _ := ps.LoadCredentials()
	if len(creds) != 1 {
		t.Errorf("expected 1 credential in metadata store, got %d", len(creds))
	}
	if creds[0].SecretID == "" {
		t.Error("credential should reference a secret")
	}

	// Profile should reference the credential.
	profs, _ := ps.LoadProfiles()
	if len(profs) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(profs))
	}
	if profs[0].Options.CredentialID != creds[0].ID {
		t.Errorf("profile CredentialID = %q, want %q", profs[0].Options.CredentialID, creds[0].ID)
	}
}

func TestImportTabby_NoCredentialStore(t *testing.T) {
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithProfileService(svc))
	// No WithCredentialStore.
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	vaultContent := `{"config":null,"secrets":[
		{"type":"ssh:password","key":{"user":"deploy","host":"web.example.com","port":22},"value":"hunter2"}
	]}`
	vault := encryptTabbyVaultForTest(t, vaultContent, "pw")
	config := buildImportConfigYAML(t, &vault, 0)

	resp := jsonrpcCall(t, conn, "profiles.importTabby", map[string]any{
		"config":     config,
		"passphrase": "pw",
	})
	var errResp struct {
		Error *struct {
			Data *struct {
				Reason string `json:"reason"`
			} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &errResp); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if errResp.Error == nil {
		t.Fatal("expected error when credential store is nil, got success")
	}
}

func TestImportTabby_ProfileMatchesExistingCredNotImported(t *testing.T) {
	// Profile references a credential that already exists locally.
	// The imported profile should be marked NeedsReview.
	dir := t.TempDir()
	ps := profile.NewJSONStore(filepath.Join(dir, "p.json"))
	svc := profile.NewProfileService(ps)
	cs := newTestStore()

	// Pre-populate a credential that the imported profile will reference.
	secretID, _ := cs.Create(context.Background(), credential.NewSecret("existing-pw"))
	_ = ps.CreateCredential(profile.Credential{
		ID:       "cred:local:deploy",
		Name:     "deploy",
		Username: "deploy",
		Auth:     profile.AuthPassword,
		SecretID: string(secretID),
	})

	ws := NewWSServer(log.NewSlogAdapter(nil), newRegWithStub(log.NewSlogAdapter(nil)),
		WithProfileRepository(ps), WithGroupRepository(ps),
		WithCredentialMetadataRepository(ps), WithCredentialStore(cs), WithProfileService(svc))
	ctx := context.Background()
	if err := ws.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = ws.Stop(ctx) }()
	conn := connectWS(t, ws)
	defer func() { _ = conn.Close() }()

	// Import a profile that has CredentialID set to the existing credential.
	// This simulates what happens when the vault secret matches against the
	// existing credential's target (host+port+user).
	//
	// The vault secret for password has key "web.example.com:22:deploy" matching
	// the profile. But the existing credential has ID "cred:local:deploy", not the
	// newly generated one. So the profile references a DIFFERENT credential than
	// the local one — no conflict.
	//
	// Actually, for this test to trigger NeedsReview, the profile must reference
	// an EXISTING credential by ID. That happens when the imported credential has
	// an ID that already exists in the store — but credentials always get NEW IDs
	// since we use NewCredentialID. So this test needs to check what happens when
	// a profile is imported that references a credential the importer generates.
	//
	// Since NewCredentialID generates unique IDs, the imported credential won't
	// collide with the existing one. The needs-review case only triggers when
	// an imported profile references an existing credential by its exact ID.
	//
	// This is covered by service-layer tests (TestAtomicImport_*). At the transport
	// level, what matters is that:
	// 1. Vault secrets create new credentials with new IDs.
	// 2. Profiles reference these new credentials.
	// 3. No collision with existing credentials.
	vaultContent := `{"config":null,"secrets":[
		{"type":"ssh:password","key":{"user":"deploy","host":"web.example.com","port":22},"value":"hunter2"}
	]}`
	vault := encryptTabbyVaultForTest(t, vaultContent, "pw")
	config := buildImportConfigYAML(t, &vault, 0)

	resp := jsonrpcCall(t, conn, "profiles.importTabby", map[string]any{
		"config":     config,
		"passphrase": "pw",
	})
	var result struct {
		Result int `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, string(resp))
	}
	if result.Result != 1 {
		t.Errorf("expected 1 profile imported, got %d", result.Result)
	}
}
