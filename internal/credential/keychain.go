package credential

import (
	"fmt"

	"github.com/zalando/go-keyring"
)

// keychainService is the service name used for SSH password entries in the
// OS keychain. Combined with the account (username), it uniquely addresses
// a credential. Mirrors Tabby's keytar key format: ssh@host:port.
const keychainServicePrefix = "ssh@"

// keychainKeyPassphraseService is the service name for private-key passphrases.
const keychainKeyPassphraseService = "ssh-private-key" //nolint:gosec // G101: service name, not a credential

// Keychain implements CredentialStore backed by the OS keychain
// (macOS Keychain via zalando/go-keyring). This is the dual-path fallback
// used when the encrypted vault is disabled — the same CredentialStore
// interface, a different backend.
type Keychain struct{}

// NewKeychain creates a Keychain credential store.
func NewKeychain() *Keychain {
	return &Keychain{}
}

// keychainKeyForConnection builds the service key for a connection identity.
// Format: ssh@host (if port is 0) or ssh@host:port — matching Tabby's keytar key.
func keychainKeyForConnection(id Identity) string {
	if id.Port > 0 {
		return fmt.Sprintf("%s%s:%d", keychainServicePrefix, id.Host, id.Port)
	}
	return keychainServicePrefix + id.Host
}

func (k *Keychain) LookupPassword(id Identity) (string, error) {
	v, err := keyring.Get(keychainKeyForConnection(id), id.User)
	if err != nil {
		if err == keyring.ErrNotFound {
			return "", nil
		}
		return "", fmt.Errorf("keychain lookup password: %w", err)
	}
	return v, nil
}

func (k *Keychain) SavePassword(id Identity, password string) error {
	if err := keyring.Set(keychainKeyForConnection(id), id.User, password); err != nil {
		return fmt.Errorf("keychain save password: %w", err)
	}
	return nil
}

func (k *Keychain) DeletePassword(id Identity) error {
	if err := keyring.Delete(keychainKeyForConnection(id), id.User); err != nil {
		if err == keyring.ErrNotFound {
			return nil
		}
		return fmt.Errorf("keychain delete password: %w", err)
	}
	return nil
}

func (k *Keychain) HasPassword(id Identity) (bool, error) {
	_, err := keyring.Get(keychainKeyForConnection(id), id.User)
	if err != nil {
		if err == keyring.ErrNotFound {
			return false, nil
		}
		return false, fmt.Errorf("keychain has password: %w", err)
	}
	return true, nil
}

func (k *Keychain) LookupKeyPassphrase(hash KeyHash) (string, error) {
	v, err := keyring.Get(keychainKeyPassphraseService, string(hash))
	if err != nil {
		if err == keyring.ErrNotFound {
			return "", nil
		}
		return "", fmt.Errorf("keychain lookup passphrase: %w", err)
	}
	return v, nil
}

func (k *Keychain) SaveKeyPassphrase(hash KeyHash, passphrase string) error {
	if err := keyring.Set(keychainKeyPassphraseService, string(hash), passphrase); err != nil {
		return fmt.Errorf("keychain save passphrase: %w", err)
	}
	return nil
}

func (k *Keychain) DeleteKeyPassphrase(hash KeyHash) error {
	if err := keyring.Delete(keychainKeyPassphraseService, string(hash)); err != nil {
		if err == keyring.ErrNotFound {
			return nil
		}
		return fmt.Errorf("keychain delete passphrase: %w", err)
	}
	return nil
}
