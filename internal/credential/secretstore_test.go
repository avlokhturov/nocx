package credential

import (
	"testing"

	"github.com/zalando/go-keyring"
)

// TestSecretStoreRoundTrip proves Set → Exists → Get → Delete → Exists-false
// for the keychain-backed SecretStore.
func TestSecretStoreRoundTrip(t *testing.T) {
	keyring.MockInit()
	store := NewKeychainSecretStore()

	id := NewSecretID()
	secret := NewSecret("test-secret-value")

	// Set
	if err := store.Set(id, secret); err != nil {
		t.Fatalf("Set: %v", err)
	}

	// Exists
	exists, err := store.Exists(id)
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if !exists {
		t.Fatal("Exists should report true after Set")
	}

	// Get
	got, err := store.Get(id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	secretEquals(t, got, "test-secret-value")

	// Delete
	if err = store.Delete(id); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	// Exists after Delete
	exists, err = store.Exists(id)
	if err != nil {
		t.Fatalf("Exists after delete: %v", err)
	}
	if exists {
		t.Fatal("Exists should report false after Delete")
	}
}

// TestSecretStoreGetAbsent proves Get on a missing ID returns an empty
// Secret with a nil error — the absence-is-not-an-error contract.
func TestSecretStoreGetAbsent(t *testing.T) {
	keyring.MockInit()
	store := NewKeychainSecretStore()

	got, err := store.Get(NewSecretID())
	if err != nil {
		t.Fatalf("Get absent: %v", err)
	}
	if !got.IsEmpty() {
		t.Fatal("Get absent should return empty Secret")
	}
}

// TestSecretStoreExistsAbsent proves Exists on a missing ID returns false.
func TestSecretStoreExistsAbsent(t *testing.T) {
	keyring.MockInit()
	store := NewKeychainSecretStore()

	exists, err := store.Exists(NewSecretID())
	if err != nil {
		t.Fatalf("Exists absent: %v", err)
	}
	if exists {
		t.Fatal("Exists should report false for absent ID")
	}
}

// TestSecretStoreDeleteAbsent proves Delete on a missing ID succeeds —
// "already absent" is success, not an error.
func TestSecretStoreDeleteAbsent(t *testing.T) {
	keyring.MockInit()
	store := NewKeychainSecretStore()

	if err := store.Delete(NewSecretID()); err != nil {
		t.Fatalf("Delete absent: %v", err)
	}
}

// TestSecretStoreUpdate proves Set on an existing ID overwrites the value.
func TestSecretStoreUpdate(t *testing.T) {
	keyring.MockInit()
	store := NewKeychainSecretStore()

	id := NewSecretID()

	if err := store.Set(id, NewSecret("first")); err != nil {
		t.Fatalf("Set first: %v", err)
	}
	if err := store.Set(id, NewSecret("second")); err != nil {
		t.Fatalf("Set second: %v", err)
	}

	got, err := store.Get(id)
	if err != nil {
		t.Fatalf("Get after update: %v", err)
	}
	secretEquals(t, got, "second")
}

// TestSecretStoreIDIsStable proves NewSecretID produces distinct, non-empty IDs.
func TestSecretStoreIDIsStable(t *testing.T) {
	id1 := NewSecretID()
	id2 := NewSecretID()

	if id1 == "" || id2 == "" {
		t.Fatal("NewSecretID must not return empty string")
	}
	if id1 == id2 {
		t.Fatal("two NewSecretID calls must produce distinct IDs")
	}
}

// TestSecretStoreCompileTimeInterface verifies the keychain store satisfies
// the SecretStore interface at compile time. This is a static assertion —
// it compiles (or doesn't) rather than running.
func TestSecretStoreCompileTimeInterface(t *testing.T) {
	// Compile-time check: NewKeychainSecretStore returns a SecretStore.
	var _ SecretStore = NewKeychainSecretStore()
}
