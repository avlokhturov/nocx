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

	id := NewSecretID()
	secret := VaultSecret{ID: id, Value: NewSecret("s3cr3t")}

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

	got, err := v2.GetSecret(id)
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
	_ = v.SaveSecret(VaultSecret{ID: NewSecretID(), Value: NewSecret("x")})

	raw, _ := v.Marshal()

	v2 := newTestVault(t)
	err := v2.Unmarshal(raw, "wrong-passphrase")
	if err == nil {
		t.Fatal("Unmarshal with wrong passphrase should fail")
	}
}

func TestVaultDeleteSecret(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass")
	id := NewSecretID()
	_ = v.SaveSecret(VaultSecret{ID: id, Value: NewSecret("x")})

	if err := v.DeleteSecret(id); err != nil {
		t.Fatalf("DeleteSecret: %v", err)
	}
	got, _ := v.GetSecret(id)
	if got != nil {
		t.Error("secret should be deleted")
	}
}

func TestVaultDedupByID(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass")
	id := NewSecretID()

	_ = v.SaveSecret(VaultSecret{ID: id, Value: NewSecret("first")})
	_ = v.SaveSecret(VaultSecret{ID: id, Value: NewSecret("second")})

	got, _ := v.GetSecret(id)
	if got == nil {
		t.Fatal("secret not found")
	}
	secretEquals(t, got.Value, "second")
}

func TestVaultGetAbsentSecret(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass")

	got, err := v.GetSecret(NewSecretID())
	if err != nil {
		t.Fatalf("GetSecret absent: %v", err)
	}
	if got != nil {
		t.Error("GetSecret should return nil for absent ID")
	}
}

func TestSecretStoreVaultAdapter(t *testing.T) {
	// Verify the vault adapter satisfies the SecretStore interface.
	v := NewVault()
	_ = v.Unlock("test")
	store := NewCredentialStore(v)
	if store == nil {
		t.Fatal("NewCredentialStore returned nil")
	}

	id := NewSecretID()
	secret := NewSecret("vault-password")

	if err := store.Set(id, secret); err != nil {
		t.Fatalf("Set: %v", err)
	}

	exists, err := store.Exists(id)
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if !exists {
		t.Fatal("Exists should report true after Set")
	}

	got, err := store.Get(id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	secretEquals(t, got, "vault-password")

	if err := store.Delete(id); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	exists, _ = store.Exists(id)
	if exists {
		t.Fatal("Exists should report false after Delete")
	}
}

func TestVaultSecretRefusesMarshal(t *testing.T) {
	v := VaultSecret{ID: NewSecretID(), Value: NewSecret("hunter2")}
	if _, err := json.Marshal(v); err == nil {
		t.Fatal("json.Marshal(VaultSecret) should error, got nil")
	} else if !strings.Contains(err.Error(), "Secret") {
		t.Errorf("marshal error should name the Secret type, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// AEAD tamper-detection tests
// ---------------------------------------------------------------------------

func TestVaultTamperedCiphertextRejected(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("test-passphrase")
	_ = v.SaveSecret(VaultSecret{ID: NewSecretID(), Value: NewSecret("s3cr3t")})

	raw, err := v.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	contents, _ := hex.DecodeString(raw.Contents)
	if len(contents) < 20 {
		t.Fatalf("contents too short: %d bytes", len(contents))
	}
	contents[12] ^= 0x01
	raw.Contents = hex.EncodeToString(contents)

	v2 := newTestVault(t)
	err = v2.Unmarshal(raw, "test-passphrase")
	if err == nil {
		t.Fatal("tampered ciphertext should be rejected")
	}
}

func TestVaultTamperedTagRejected(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("test-passphrase")
	_ = v.SaveSecret(VaultSecret{ID: NewSecretID(), Value: NewSecret("s3cr3t")})

	raw, err := v.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	contents, _ := hex.DecodeString(raw.Contents)
	if len(contents) < 28 {
		t.Fatalf("contents too short: %d bytes", len(contents))
	}
	contents[len(contents)-1] ^= 0x01
	raw.Contents = hex.EncodeToString(contents)

	v2 := newTestVault(t)
	err = v2.Unmarshal(raw, "test-passphrase")
	if err == nil {
		t.Fatal("tampered tag should be rejected")
	}
}

func TestVaultTamperedVersionRejected(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("test-passphrase")
	_ = v.SaveSecret(VaultSecret{ID: NewSecretID(), Value: NewSecret("s3cr3t")})

	raw, err := v.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	raw.Version = 999

	v2 := newTestVault(t)
	err = v2.Unmarshal(raw, "test-passphrase")
	if err == nil {
		t.Fatal("tampered version should be rejected")
	}
}

func TestVaultOldFormatRefused(t *testing.T) {
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
	if !strings.Contains(err.Error(), "version") && !strings.Contains(err.Error(), "format") {
		t.Errorf("error should mention version/format, got: %v", err)
	}
}

func TestVaultWrongPasswordIndistinguishableFromTamper(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("correct-passphrase")
	_ = v.SaveSecret(VaultSecret{ID: NewSecretID(), Value: NewSecret("s3cr3t")})

	raw, err := v.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	vWrong := newTestVault(t)
	wrongErr := vWrong.Unmarshal(raw, "wrong-passphrase")
	if wrongErr == nil {
		t.Fatal("wrong passphrase should fail")
	}

	contents, _ := hex.DecodeString(raw.Contents)
	contents[len(contents)-1] ^= 0x01
	raw.Contents = hex.EncodeToString(contents)

	vTampered := newTestVault(t)
	tamperErr := vTampered.Unmarshal(raw, "correct-passphrase")
	if tamperErr == nil {
		t.Fatal("tampered vault should fail")
	}

	if wrongErr.Error() != tamperErr.Error() {
		t.Errorf("wrong-password and tampered-data errors must be indistinguishable:\n  wrong:   %v\n  tamper:  %v", wrongErr, tamperErr)
	}
}
