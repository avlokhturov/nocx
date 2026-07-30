package vault

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/shady2k/nocx/internal/credential"
	"github.com/shady2k/nocx/internal/storage"
)

// test references must have exactly 32 hex characters for the material part
// (idMaterialLen = 32 in id.go).
const (
	refSys   = "sec:v1:system:9f0c8a1b2c3d4e5faabbccdd00112233"
	refUnreg = "sec:v1:unreg:aabbccdd00112233aabbccdd00112233"
	refFile  = "sec:v1:file:aabbccdd00112233aabbccdd00112233"
)

// ---------------------------------------------------------------------------
// ProviderOf
// ---------------------------------------------------------------------------

func TestProviderOf_ValidReference(t *testing.T) {
	p, err := ProviderOf(refSys)
	if err != nil {
		t.Fatalf("ProviderOf: %v", err)
	}
	if p != ProviderSystem {
		t.Errorf("got provider %q, want %q", p, ProviderSystem)
	}
}

func TestProviderOf_FileReference(t *testing.T) {
	p, err := ProviderOf(refFile)
	if err != nil {
		t.Fatalf("ProviderOf: %v", err)
	}
	if p != ProviderFile {
		t.Errorf("got provider %q, want %q", p, ProviderFile)
	}
}

func TestProviderOf_MalformedReference(t *testing.T) {
	tests := []struct {
		name string
		id   credential.SecretID
	}{
		{"empty", ""},
		{"too_few_parts", "sec:v1:system"},
		{"bad_prefix", "bad:v1:system:abcd1234abcd1234abcd1234abcd1234"},
		{"bad_version", "sec:v0:system:abcd1234abcd1234abcd1234abcd1234"},
		{"bad_material", "sec:v1:system:"},
		{"short_material", "sec:v1:system:abcd1234"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ProviderOf(tt.id)
			if err == nil {
				t.Error("expected error, got nil")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ProviderStatus
// ---------------------------------------------------------------------------

func TestProviderStatus_RegisteredReady(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	p, ready, reason, err := v.ProviderStatus(context.Background(), refSys)
	if err != nil {
		t.Fatalf("ProviderStatus: %v", err)
	}
	if p != ProviderSystem {
		t.Errorf("provider = %q, want %q", p, ProviderSystem)
	}
	if !ready {
		t.Errorf("expected ready, got reason=%q", reason)
	}
}

func TestProviderStatus_UnregisteredProvider(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	p, ready, reason, err := v.ProviderStatus(context.Background(), refUnreg)
	if err != nil {
		t.Fatalf("ProviderStatus: %v", err)
	}
	if p != ProviderID("unreg") {
		t.Errorf("provider = %q, want %q", p, "unreg")
	}
	if ready {
		t.Error("expected not ready for unregistered provider")
	}
	if reason != ReasonUnknownProvider {
		t.Errorf("reason = %q, want %q", reason, ReasonUnknownProvider)
	}
}

func TestProviderStatus_MalformedReference(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	_, _, _, err := v.ProviderStatus(context.Background(), "bad-ref")
	if err == nil {
		t.Error("expected error for malformed reference")
	}
}

// ---------------------------------------------------------------------------
// BuildInventory — state gating
// ---------------------------------------------------------------------------

func TestBuildInventory_SealedVault(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	v.Seal()

	_, err := v.BuildInventory(context.Background(), nil)
	if err != ErrVaultSealed {
		t.Fatalf("BuildInventory sealed: got %v, want ErrVaultSealed", err)
	}
}

func TestBuildInventory_UninitializedVault(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))

	_, err := v.BuildInventory(context.Background(), nil)
	if err != ErrVaultUninitialized {
		t.Fatalf("BuildInventory uninitialized: got %v, want ErrVaultUninitialized", err)
	}
}

// ---------------------------------------------------------------------------
// BuildInventory — entries
// ---------------------------------------------------------------------------

func TestBuildInventory_PasswordEntry(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	inputs := []CredentialInventory{
		{
			ID:       "cred:test:1",
			Username: "deploy",
			AuthMode: "password",
			SecretID: refSys,
		},
	}

	entries, err := v.BuildInventory(context.Background(), inputs)
	if err != nil {
		t.Fatalf("BuildInventory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	e := entries[0]
	if e.Kind != "password" {
		t.Errorf("kind = %q, want %q", e.Kind, "password")
	}
	if e.Provider != "system" {
		t.Errorf("provider = %q, want %q", e.Provider, "system")
	}
	if e.OwnerID != "cred:test:1" {
		t.Errorf("ownerId = %q, want %q", e.OwnerID, "cred:test:1")
	}
	if e.Reachable != true {
		t.Errorf("reachable = %v, want true", e.Reachable)
	}
}

func TestBuildInventory_PassphraseEntry(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	inputs := []CredentialInventory{
		{
			ID:       "cred:test:1",
			Username: "deploy",
			AuthMode: "publicKey",
			Versions: []CredentialVersionInventory{
				{
					PassphraseSecretID: refSys,
					KeyFingerprint:     "bdc73f37a1b2c3d4e5f6a7b8c9d0e1f2",
				},
			},
		},
	}

	entries, err := v.BuildInventory(context.Background(), inputs)
	if err != nil {
		t.Fatalf("BuildInventory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	e := entries[0]
	if e.Kind != "key-passphrase" {
		t.Errorf("kind = %q, want %q", e.Kind, "key-passphrase")
	}
	if e.Label != "Passphrase for key SHA256:bdc73f37…" {
		t.Errorf("label = %q, want %q", e.Label, "Passphrase for key SHA256:bdc73f37…")
	}
}

func TestBuildInventory_SingleUseLabelIncludesHostPort(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	inputs := []CredentialInventory{
		{
			ID:         "cred:test:1",
			Username:   "deploy",
			AuthMode:   "password",
			SecretID:   refSys,
			UsageCount: 1,
			SingleHost: "vm-dsm01",
			SinglePort: 22,
		},
	}

	entries, err := v.BuildInventory(context.Background(), inputs)
	if err != nil {
		t.Fatalf("BuildInventory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	if entries[0].Label != "SSH password for deploy@vm-dsm01:22" {
		t.Errorf("label = %q, want %q", entries[0].Label, "SSH password for deploy@vm-dsm01:22")
	}
}

func TestBuildInventory_SharedLabelOmitsHost(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	inputs := []CredentialInventory{
		{
			ID:         "cred:test:1",
			Username:   "deploy",
			AuthMode:   "password",
			SecretID:   refSys,
			UsageCount: 3,
		},
	}

	entries, err := v.BuildInventory(context.Background(), inputs)
	if err != nil {
		t.Fatalf("BuildInventory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	if entries[0].Label != "SSH password for deploy" {
		t.Errorf("label = %q, want %q", entries[0].Label, "SSH password for deploy")
	}
}

func TestBuildInventory_UnregisteredProviderIsUnreachable(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	inputs := []CredentialInventory{
		{
			ID:       "cred:test:1",
			Username: "root",
			AuthMode: "password",
			SecretID: refUnreg,
		},
	}

	entries, err := v.BuildInventory(context.Background(), inputs)
	if err != nil {
		t.Fatalf("BuildInventory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	if entries[0].Reachable {
		t.Error("expected unreachable for unregistered provider")
	}
	if entries[0].Provider != "unreg" {
		t.Errorf("provider = %q, want %q", entries[0].Provider, "unreg")
	}
}

func TestBuildInventory_MalformedRefSkipped(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	inputs := []CredentialInventory{
		{
			ID:       "cred:test:1",
			Username: "root",
			AuthMode: "password",
			SecretID: "invalid-ref",
		},
	}

	entries, err := v.BuildInventory(context.Background(), inputs)
	if err != nil {
		t.Fatalf("BuildInventory: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries for malformed ref, got %d", len(entries))
	}
}

func TestBuildInventory_DedupReferencesAcrossVersions(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	inputs := []CredentialInventory{
		{
			ID:       "cred:test:1",
			Username: "root",
			AuthMode: "password",
			Versions: []CredentialVersionInventory{
				{PasswordSecretID: refSys},
				{PasswordSecretID: refSys}, // same ref carried forward
			},
		},
	}

	entries, err := v.BuildInventory(context.Background(), inputs)
	if err != nil {
		t.Fatalf("BuildInventory: %v", err)
	}
	if len(entries) != 1 {
		t.Errorf("expected 1 entry after dedup, got %d", len(entries))
	}
}

func TestBuildInventory_MultipleCredentials(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	refA := "sec:v1:system:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	refB := "sec:v1:system:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	inputs := []CredentialInventory{
		{
			ID:       "cred:pass:1",
			Username: "alice",
			SecretID: refA,
		},
		{
			ID:                 "cred:key:2",
			Username:           "bob",
			PassphraseSecretID: refB,
		},
	}

	entries, err := v.BuildInventory(context.Background(), inputs)
	if err != nil {
		t.Fatalf("BuildInventory: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(entries))
	}
	if entries[0].OwnerID != "cred:key:2" {
		t.Errorf("entries[0].OwnerID = %q, want %q (first by sort)", entries[0].OwnerID, "cred:key:2")
	}
	if entries[1].OwnerID != "cred:pass:1" {
		t.Errorf("entries[1].OwnerID = %q, want %q", entries[1].OwnerID, "cred:pass:1")
	}
}

func TestBuildInventory_RealFileProvider(t *testing.T) {
	dir := t.TempDir()
	docStore := storage.NewDocumentStore(dir)
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))

	reg, err := NewRegistry(newTestProvider(ProviderFile))
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	v, err := New(docStore, reg, logger)
	if err != nil {
		t.Fatalf("vault.New: %v", err)
	}
	defer v.Close()

	mustSetup(t, v, "test-password")

	inputs := []CredentialInventory{
		{
			ID:       "cred:real:1",
			Username: "testuser",
			SecretID: refFile,
		},
	}

	entries, err := v.BuildInventory(context.Background(), inputs)
	if err != nil {
		t.Fatalf("BuildInventory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	if entries[0].Provider != "file" {
		t.Errorf("provider = %q, want %q", entries[0].Provider, "file")
	}
	if !entries[0].Reachable {
		t.Error("expected reachable for file provider")
	}
}

func TestBuildInventory_LegacyAndVersionRefsCombined(t *testing.T) {
	v, _, _ := testVault(t, newTestProvider(ProviderSystem))
	mustSetup(t, v, "test-pass")
	defer v.Close()

	refA := "sec:v1:system:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	refB := "sec:v1:system:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	refC := "sec:v1:system:cccccccccccccccccccccccccccccccc"

	inputs := []CredentialInventory{
		{
			ID:                 "cred:mixed:1",
			Username:           "mixed",
			AuthMode:           "password",
			SecretID:           refA, // legacy
			PassphraseSecretID: refB, // legacy
			Versions: []CredentialVersionInventory{
				{PasswordSecretID: refA}, // same as legacy — dedup
				{PassphraseSecretID: refC, KeyFingerprint: "abcdef1234567890abcdef1234567890"},
			},
		},
	}

	entries, err := v.BuildInventory(context.Background(), inputs)
	if err != nil {
		t.Fatalf("BuildInventory: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries (2 from legacy + 1 from versions, 1 dedup'd), got %d", len(entries))
	}

	// Verify all three unique refs are present.
	seen := make(map[string]bool)
	for _, e := range entries {
		seen[e.Kind+":"+e.Provider] = true
	}
	if !seen["password:system"] {
		t.Error("missing password entry")
	}
	if !seen["key-passphrase:system"] {
		t.Error("missing key-passphrase entry")
	}
}
