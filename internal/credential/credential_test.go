package credential

import (
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestVaultEncryptDecryptRoundTrip(t *testing.T) {
	v := newTestVault(t)
	passphrase := "correct horse battery staple"

	secret := VaultSecret{Type: SecretTypePassword, Key: VaultKey{User: "alice", Host: "example.com", Port: 22}, Value: NewSecret("s3cr3t")}

	if err := v.Unlock(passphrase); err != nil {
		t.Fatalf("Unlock: %v", err)
	}

	if err := v.SaveSecret(secret); err != nil {
		t.Fatalf("SaveSecret: %v", err)
	}

	// Serialize and reload to verify persistence.
	raw, marshalErr := v.Marshal()
	if marshalErr != nil {
		t.Fatalf("Marshal: %v", marshalErr)
	}

	v2 := newTestVault(t)
	if unmarshalErr := v2.Unmarshal(raw, passphrase); unmarshalErr != nil {
		t.Fatalf("Unmarshal: %v", unmarshalErr)
	}

	got, err := v2.GetSecret(SecretTypePassword, VaultKey{User: "alice", Host: "example.com", Port: 22})
	if err != nil {
		t.Fatalf("GetSecret: %v", err)
	}
	if got == nil {
		t.Fatal("secret not found after reload")
	}
	secretEquals(t, got.Value, "s3cr3t")
}

func TestVaultWrongPassphrase(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass1")
	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: VaultKey{User: "a", Host: "h", Port: 22}, Value: NewSecret("x")})

	raw, _ := v.Marshal()

	v2 := newTestVault(t)
	err := v2.Unmarshal(raw, "wrong-passphrase")
	if err == nil {
		t.Fatal("Unmarshal with wrong passphrase should fail")
	}
}

func TestVaultKeyMatchFieldByField(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass")

	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: VaultKey{User: "alice", Host: "example.com", Port: 22}, Value: NewSecret("pw")})

	// Exact match.
	got, _ := v.GetSecret(SecretTypePassword, VaultKey{User: "alice", Host: "example.com", Port: 22})
	if got == nil {
		t.Fatal("exact match failed")
	}

	// Wrong user.
	got, _ = v.GetSecret(SecretTypePassword, VaultKey{User: "bob", Host: "example.com", Port: 22})
	if got != nil {
		t.Error("wrong user should not match")
	}

	// Wrong host.
	got, _ = v.GetSecret(SecretTypePassword, VaultKey{User: "alice", Host: "other.com", Port: 22})
	if got != nil {
		t.Error("wrong host should not match")
	}

	// Wrong port.
	got, _ = v.GetSecret(SecretTypePassword, VaultKey{User: "alice", Host: "example.com", Port: 2222})
	if got != nil {
		t.Error("wrong port should not match")
	}
}

func TestVaultHostNullFallback(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass")

	// Store a default credential with host="" (shared across servers).
	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: VaultKey{User: "alice", Host: "", Port: 0}, Value: NewSecret("default-pw")})

	// Lookup with a specific host should fall back to the host-null entry.
	got, _ := v.GetSecret(SecretTypePassword, VaultKey{User: "alice", Host: "anyhost.com", Port: 22})
	if got == nil {
		t.Fatal("host-null fallback should find the default credential")
	}
	secretEquals(t, got.Value, "default-pw")
}

func TestVaultDeleteSecret(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass")
	key := VaultKey{User: "a", Host: "h", Port: 22}
	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: key, Value: NewSecret("x")})

	if err := v.DeleteSecret(SecretTypePassword, key); err != nil {
		t.Fatalf("DeleteSecret: %v", err)
	}
	got, _ := v.GetSecret(SecretTypePassword, key)
	if got != nil {
		t.Error("secret should be deleted")
	}
}

func TestVaultDedupByKey(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass")
	key := VaultKey{User: "a", Host: "h", Port: 22}

	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: key, Value: NewSecret("first")})
	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: key, Value: NewSecret("second")})

	got, _ := v.GetSecret(SecretTypePassword, key)
	if got == nil {
		t.Fatal("secret not found")
	}
	secretEquals(t, got.Value, "second")
}

func TestVaultKeyPassphraseByHash(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass")

	keyHash := "sha512:abc123def456"
	_ = v.SaveSecret(VaultSecret{Type: SecretTypeKeyPassphrase, Key: VaultKey{Hash: keyHash}, Value: NewSecret("passphrase")})

	got, _ := v.GetSecret(SecretTypeKeyPassphrase, VaultKey{Hash: keyHash})
	if got == nil {
		t.Fatal("key passphrase not found")
	}
	secretEquals(t, got.Value, "passphrase")
}

func TestCredentialStoreInterface(t *testing.T) {
	// Verify the vault adapter satisfies the CredentialStore interface at
	// compile time. A concrete pointer can never be nil, so we assert the
	// interface via a type assertion rather than a nil comparison.
	store := NewCredentialStore(NewVault())
	if store == nil {
		t.Fatal("NewCredentialStore returned nil")
	}
	var _ CredentialStore = store
}

// TestVaultSecretRefusesMarshal proves the type boundary: a VaultSecret
// cannot be json.Marshal'd because its Value is a Secret. This is the
// accident-prevention the Secret type exists for — a future encoder that
// happens to marshal a struct containing a secret fails loudly at the call
// site rather than silently shipping plaintext (or "[REDACTED]").
func TestVaultSecretRefusesMarshal(t *testing.T) {
	v := VaultSecret{Type: SecretTypePassword, Key: VaultKey{User: "a"}, Value: NewSecret("hunter2")}
	if _, err := json.Marshal(v); err == nil {
		t.Fatal("json.Marshal(VaultSecret) should error, got nil")
	} else if !strings.Contains(err.Error(), "Secret") {
		t.Errorf("marshal error should name the Secret type, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// AEAD tamper-detection tests (TDD: these must FAIL on current CBC code
// where they detect the vulnerability — tampering should always be caught).
// ---------------------------------------------------------------------------

func TestVaultTamperedCiphertextRejected(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("test-passphrase")
	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: VaultKey{User: "alice", Host: "example.com", Port: 22}, Value: NewSecret("s3cr3t")})

	raw, err := v.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	// Flip a byte in the ciphertext portion (not the nonce or tag).
	contents, _ := hex.DecodeString(raw.Contents)
	if len(contents) < 20 {
		t.Fatalf("contents too short: %d bytes", len(contents))
	}
	contents[12] ^= 0x01 // flip a bit just past the 12-byte nonce
	raw.Contents = hex.EncodeToString(contents)

	v2 := newTestVault(t)
	err = v2.Unmarshal(raw, "test-passphrase")
	if err == nil {
		t.Fatal("tampered ciphertext should be rejected, but decryption succeeded")
	}
}

func TestVaultTamperedTagRejected(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("test-passphrase")
	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: VaultKey{User: "alice", Host: "example.com", Port: 22}, Value: NewSecret("s3cr3t")})

	raw, err := v.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	// Flip a byte in the tag area (last 16 bytes of GCM output).
	contents, _ := hex.DecodeString(raw.Contents)
	if len(contents) < 28 {
		t.Fatalf("contents too short: %d bytes", len(contents))
	}
	contents[len(contents)-1] ^= 0x01
	raw.Contents = hex.EncodeToString(contents)

	v2 := newTestVault(t)
	err = v2.Unmarshal(raw, "test-passphrase")
	if err == nil {
		t.Fatal("tampered tag should be rejected, but decryption succeeded")
	}
}

func TestVaultTamperedVersionRejected(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("test-passphrase")
	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: VaultKey{User: "alice", Host: "example.com", Port: 22}, Value: NewSecret("s3cr3t")})

	raw, err := v.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	// Change the version field.
	raw.Version = 999

	v2 := newTestVault(t)
	err = v2.Unmarshal(raw, "test-passphrase")
	if err == nil {
		t.Fatal("tampered version should be rejected, but decryption succeeded")
	}
}

func TestVaultOldFormatRefused(t *testing.T) {
	// A version=1 StoredVault (old CBC format). Must be refused with
	// a clear message, not a confusing decrypt error.
	v1 := &StoredVault{
		Version:  1,
		Contents: "deadbeef",
		KeySalt:  "aabbccdd",
		IV:       "00112233445566778899aabbccddeeff",
	}

	v := newTestVault(t)
	err := v.Unmarshal(v1, "any-passphrase")
	if err == nil {
		t.Fatal("version-1 vault should be refused")
	}
	// The error must say *why* — not a generic "wrong passphrase".
	if !strings.Contains(err.Error(), "version") && !strings.Contains(err.Error(), "format") {
		t.Errorf("error should mention version/format, got: %v", err)
	}
}

func TestVaultWrongPasswordIndistinguishableFromTamper(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("correct-passphrase")
	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: VaultKey{User: "alice", Host: "example.com", Port: 22}, Value: NewSecret("s3cr3t")})

	raw, err := v.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	// Wrong password.
	vWrong := newTestVault(t)
	wrongErr := vWrong.Unmarshal(raw, "wrong-passphrase")
	if wrongErr == nil {
		t.Fatal("wrong passphrase should fail")
	}

	// Tampered contents.
	contents, _ := hex.DecodeString(raw.Contents)
	contents[len(contents)-1] ^= 0x01
	raw.Contents = hex.EncodeToString(contents)

	vTampered := newTestVault(t)
	tamperErr := vTampered.Unmarshal(raw, "correct-passphrase")
	if tamperErr == nil {
		t.Fatal("tampered vault should fail")
	}

	// Same error message for both paths (indistinguishable to caller).
	if wrongErr.Error() != tamperErr.Error() {
		t.Errorf("wrong-password and tampered-data errors must be indistinguishable:\n  wrong:   %v\n  tamper:  %v", wrongErr, tamperErr)
	}
}
