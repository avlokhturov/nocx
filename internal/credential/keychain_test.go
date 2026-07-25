package credential

import (
	"testing"

	"github.com/zalando/go-keyring"
)

func TestKeychainPasswordRoundTrip(t *testing.T) {
	keyring.MockInit()
	kc := NewKeychain()

	id := Identity{User: "alice", Host: "example.com", Port: 22}
	if err := kc.SavePassword(id, "secret123"); err != nil {
		t.Fatalf("SavePassword: %v", err)
	}

	has, err := kc.HasPassword(id)
	if err != nil {
		t.Fatalf("HasPassword: %v", err)
	}
	if !has {
		t.Fatal("HasPassword should report true after save")
	}

	got, err := kc.LookupPassword(id)
	if err != nil {
		t.Fatalf("LookupPassword: %v", err)
	}
	if got != "secret123" {
		t.Errorf("LookupPassword = %q, want secret123", got)
	}
}

func TestKeychainPasswordNotFound(t *testing.T) {
	keyring.MockInit()
	kc := NewKeychain()

	id := Identity{User: "ghost", Host: "nowhere.com", Port: 22}
	got, err := kc.LookupPassword(id)
	if err != nil {
		t.Fatalf("LookupPassword on missing should not error: %v", err)
	}
	if got != "" {
		t.Errorf("LookupPassword on missing = %q, want empty", got)
	}
	has, _ := kc.HasPassword(id)
	if has {
		t.Error("HasPassword on missing should be false")
	}
}

func TestKeychainPasswordUpdate(t *testing.T) {
	keyring.MockInit()
	kc := NewKeychain()
	id := Identity{User: "bob", Host: "h", Port: 22}

	_ = kc.SavePassword(id, "first")
	_ = kc.SavePassword(id, "second")
	got, _ := kc.LookupPassword(id)
	if got != "second" {
		t.Errorf("after update = %q, want second", got)
	}
}

func TestKeychainPasswordDelete(t *testing.T) {
	keyring.MockInit()
	kc := NewKeychain()
	id := Identity{User: "alice", Host: "h", Port: 22}

	_ = kc.SavePassword(id, "pw")
	if err := kc.DeletePassword(id); err != nil {
		t.Fatalf("DeletePassword: %v", err)
	}
	got, _ := kc.LookupPassword(id)
	if got != "" {
		t.Errorf("after delete = %q, want empty", got)
	}
	has, _ := kc.HasPassword(id)
	if has {
		t.Error("HasPassword should be false after delete")
	}
}

func TestKeychainKeyPassphraseRoundTrip(t *testing.T) {
	keyring.MockInit()
	kc := NewKeychain()

	hash := KeyHash("sha512:abc123")
	if err := kc.SaveKeyPassphrase(hash, "passphrase-x"); err != nil {
		t.Fatalf("SaveKeyPassphrase: %v", err)
	}
	got, err := kc.LookupKeyPassphrase(hash)
	if err != nil {
		t.Fatalf("LookupKeyPassphrase: %v", err)
	}
	if got != "passphrase-x" {
		t.Errorf("LookupKeyPassphrase = %q, want passphrase-x", got)
	}
}

func TestKeychainKeyPassphraseDelete(t *testing.T) {
	keyring.MockInit()
	kc := NewKeychain()
	hash := KeyHash("sha512:del")
	_ = kc.SaveKeyPassphrase(hash, "p")

	if err := kc.DeleteKeyPassphrase(hash); err != nil {
		t.Fatalf("DeleteKeyPassphrase: %v", err)
	}
	got, _ := kc.LookupKeyPassphrase(hash)
	if got != "" {
		t.Errorf("after delete = %q, want empty", got)
	}
}

func TestKeychainKeyFormat(t *testing.T) {
	id := Identity{User: "alice", Host: "example.com", Port: 22}
	key := keychainKeyForConnection(id)
	want := "ssh@example.com:22"
	if key != want {
		t.Errorf("key = %q, want %q", key, want)
	}

	id2 := Identity{User: "alice", Host: "example.com", Port: 0}
	key2 := keychainKeyForConnection(id2)
	want2 := "ssh@example.com"
	if key2 != want2 {
		t.Errorf("key (port 0) = %q, want %q", key2, want2)
	}
}

func TestKeychainImplementsCredentialStore(t *testing.T) {
	keyring.MockInit()
	var _ CredentialStore = NewKeychain()
}
