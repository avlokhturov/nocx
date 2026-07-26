package credential

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"

	"github.com/zalando/go-keyring"
)

// SecretID is an opaque, stable handle to secret material held by a
// SecretStore. It is the ONLY form in which a secret may appear in a
// persisted domain record or cross a package boundary (ADR-0011 §2).
type SecretID string

// NewSecretID mints a fresh, collision-free ID: "sec:" + random hex.
func NewSecretID() SecretID {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return SecretID("sec:" + hex.EncodeToString(b[:]))
}

// SecretStore holds authenticators in the OS keychain. Its operations are
// deliberately set/delete/exists plus a backend-only Get; there is no API
// that hands plaintext to the renderer (ADR-0011 §2).
type SecretStore interface {
	Get(id SecretID) (Secret, error) // empty Secret, nil error when absent
	Set(id SecretID, value Secret) error
	Delete(id SecretID) error
	Exists(id SecretID) (bool, error)
}

// ---------------------------------------------------------------------------
// Keychain-backed SecretStore
// ---------------------------------------------------------------------------

// keychainSecretService is the single service name for all nocx secrets in the
// OS keychain. Account = string(id); nothing is ever re-derived from a file
// path or from a key's contents (ADR-0011 §1).
const keychainSecretService = "nocx"

// KeychainSecretStore implements SecretStore backed by the OS keychain via
// zalando/go-keyring. One service name for all nocx secrets.
type KeychainSecretStore struct{}

// NewKeychainSecretStore creates a keychain-backed SecretStore.
func NewKeychainSecretStore() *KeychainSecretStore {
	return &KeychainSecretStore{}
}

func (k *KeychainSecretStore) Get(id SecretID) (Secret, error) {
	val, err := keyring.Get(keychainSecretService, string(id))
	if err != nil {
		if err == keyring.ErrNotFound {
			return Secret{}, nil // absent is not an error
		}
		return Secret{}, fmt.Errorf("keychain get %s: %w", id, err)
	}
	return NewSecret(val), nil
}

func (k *KeychainSecretStore) Set(id SecretID, value Secret) error {
	var plaintext string
	if err := value.Use(func(b []byte) error { plaintext = string(b); return nil }); err != nil {
		return fmt.Errorf("secret use: %w", err)
	}
	if err := keyring.Set(keychainSecretService, string(id), plaintext); err != nil {
		return fmt.Errorf("keychain set %s: %w", id, err)
	}
	return nil
}

func (k *KeychainSecretStore) Delete(id SecretID) error {
	if err := keyring.Delete(keychainSecretService, string(id)); err != nil {
		if err == keyring.ErrNotFound {
			return nil // already absent is success
		}
		return fmt.Errorf("keychain delete %s: %w", id, err)
	}
	return nil
}

func (k *KeychainSecretStore) Exists(id SecretID) (bool, error) {
	_, err := keyring.Get(keychainSecretService, string(id))
	if err == nil {
		return true, nil
	}
	if err == keyring.ErrNotFound {
		return false, nil
	}
	return false, fmt.Errorf("keychain exists %s: %w", id, err)
}
