package credential

import (
	"testing"
)

func TestVaultEncryptDecryptRoundTrip(t *testing.T) {
	v := newTestVault(t)
	passphrase := "correct horse battery staple"

	secret := VaultSecret{
		Type:  SecretTypePassword,
		Key:   VaultKey{User: "alice", Host: "example.com", Port: 22},
		Value: "s3cr3t",
	}

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
	if got.Value != "s3cr3t" {
		t.Errorf("value = %q, want s3cr3t", got.Value)
	}
}

func TestVaultWrongPassphrase(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass1")
	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: VaultKey{User: "a", Host: "h", Port: 22}, Value: "x"})

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

	_ = v.SaveSecret(VaultSecret{
		Type:  SecretTypePassword,
		Key:   VaultKey{User: "alice", Host: "example.com", Port: 22},
		Value: "pw",
	})

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
	_ = v.SaveSecret(VaultSecret{
		Type:  SecretTypePassword,
		Key:   VaultKey{User: "alice", Host: "", Port: 0},
		Value: "default-pw",
	})

	// Lookup with a specific host should fall back to the host-null entry.
	got, _ := v.GetSecret(SecretTypePassword, VaultKey{User: "alice", Host: "anyhost.com", Port: 22})
	if got == nil {
		t.Fatal("host-null fallback should find the default credential")
	}
	if got.Value != "default-pw" {
		t.Errorf("value = %q, want default-pw", got.Value)
	}
}

func TestVaultDeleteSecret(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass")
	key := VaultKey{User: "a", Host: "h", Port: 22}
	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: key, Value: "x"})

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

	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: key, Value: "first"})
	_ = v.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: key, Value: "second"})

	got, _ := v.GetSecret(SecretTypePassword, key)
	if got == nil {
		t.Fatal("secret not found")
	}
	if got.Value != "second" {
		t.Errorf("value = %q, want second (update, not duplicate)", got.Value)
	}
}

func TestVaultKeyPassphraseByHash(t *testing.T) {
	v := newTestVault(t)
	_ = v.Unlock("pass")

	keyHash := "sha512:abc123def456"
	_ = v.SaveSecret(VaultSecret{
		Type:  SecretTypeKeyPassphrase,
		Key:   VaultKey{Hash: keyHash},
		Value: "passphrase",
	})

	got, _ := v.GetSecret(SecretTypeKeyPassphrase, VaultKey{Hash: keyHash})
	if got == nil {
		t.Fatal("key passphrase not found")
	}
	if got.Value != "passphrase" {
		t.Errorf("value = %q, want passphrase", got.Value)
	}
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
