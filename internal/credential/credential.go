package credential

import (
	"crypto/sha512"
	"encoding/hex"
)

// Identity identifies an SSH connection for credential lookup.
// A credential is addressed by the connection identity {user, host, port},
// never embedded in a profile. This is the core seam between the profile
// manager (clear data) and the credential store (secrets).
type Identity struct {
	User string
	Host string
	Port int
}

// KeyHash identifies a private key for passphrase lookup. It is the
// sha512 hash of the key contents — decoupled from connection identity
// so one key's passphrase can be reused across hosts.
type KeyHash string

// HashKey derives the KeyHash for a private key from its raw bytes. The
// format is "sha512:<hex(sha512(key))>" — a stable, content-addressed key
// that survives key moves and is independent of the file path. This is the
// canonical derivation both the save path (when a passphrase is first
// stored) and the delete path (when a credential referencing the key is
// removed) must use, so a secret saved under HashKey(data) is reachable
// for deletion by re-reading the same key file.
//
// Hashing the raw bytes (not the path) means renaming or moving a key does
// not orphan its passphrase. Two credentials pointing at the same file
// share one passphrase entry; the credential delete cascade deletes it
// when the first credential goes — a documented compromise recorded in the
// delete-cascade handler, since the model has no secret reference count.
func HashKey(key []byte) KeyHash {
	sum := sha512.Sum512(key)
	return KeyHash("sha512:" + hex.EncodeToString(sum[:]))
}

// CredentialStore is the seam between the profile manager (clear data)
// and the secret store. SSH never calls the vault directly — this
// interface is the single chokepoint, dual-path: encrypted vault or
// OS keychain (both implement this interface).
type CredentialStore interface {
	// LookupPassword returns the stored password for the identity, or an
	// empty Secret if none is stored. The password is wrapped in a Secret
	// so it cannot be serialized by accident; use Secret.Use to read it.
	LookupPassword(id Identity) (Secret, error)
	// SavePassword stores (or updates) the password for the identity.
	SavePassword(id Identity, password string) error
	// DeletePassword removes the stored password for the identity.
	DeletePassword(id Identity) error
	// HasPassword reports whether a password is stored for the identity.
	HasPassword(id Identity) (bool, error)

	// LookupKeyPassphrase returns the stored passphrase for the key hash,
	// or an empty Secret if none is stored. Use Secret.Use to read it.
	LookupKeyPassphrase(hash KeyHash) (Secret, error)
	// SaveKeyPassphrase stores (or updates) the passphrase for the key hash.
	SaveKeyPassphrase(hash KeyHash, passphrase string) error
	// DeleteKeyPassphrase removes the stored passphrase for the key hash.
	DeleteKeyPassphrase(hash KeyHash) error
}

// SecretType namespaces secrets within the vault.
type SecretType string

const (
	SecretTypePassword      SecretType = "ssh:password"       //nolint:gosec // G101: not a hardcoded credential, it's a type namespace
	SecretTypeKeyPassphrase SecretType = "ssh:key-passphrase" //nolint:gosec // G101: not a hardcoded credential, it's a type namespace
)

// VaultKey is the lookup key for a vault secret. For connection passwords,
// {User, Host, Port} are set and Hash is empty. For key passphrases,
// Hash is set and the identity fields are empty.
type VaultKey struct {
	User string
	Host string
	Port int
	Hash string
}

// VaultSecret is a single secret entry in the vault. The Value is a Secret
// so it cannot be serialized by accident — see secret.go. The vault
// persists through a private DTO that materializes plaintext only inside
// the encryption callback (vault.Marshal).
type VaultSecret struct {
	Type  SecretType `json:"type"`
	Key   VaultKey   `json:"key"`
	Value Secret     `json:"value"`
}

// matches checks whether the stored secret's key matches the lookup key
// field-by-field. For connection passwords, all of User/Host/Port must
// match. For key passphrases, Hash must match.
func (s VaultSecret) matches(typ SecretType, key VaultKey) bool {
	if s.Type != typ {
		return false
	}
	if typ == SecretTypeKeyPassphrase {
		return s.Key.Hash != "" && s.Key.Hash == key.Hash
	}
	return s.Key.User == key.User && s.Key.Host == key.Host && s.Key.Port == key.Port
}

// vaultCredentialAdapter adapts the raw encrypted vault to the
// CredentialStore interface. This is the single place SSH code touches
// credentials — it never sees the vault encryption or passphrase.
type vaultCredentialAdapter struct {
	vault *Vault
}

// NewCredentialStore wraps a Vault behind the CredentialStore interface.
func NewCredentialStore(v *Vault) CredentialStore {
	return &vaultCredentialAdapter{vault: v}
}

func (a *vaultCredentialAdapter) LookupPassword(id Identity) (Secret, error) {
	key := VaultKey{User: id.User, Host: id.Host, Port: id.Port}
	s, err := a.vault.GetSecret(SecretTypePassword, key)
	if err != nil {
		return Secret{}, err
	}
	if s == nil {
		return Secret{}, nil
	}
	return s.Value, nil
}

func (a *vaultCredentialAdapter) SavePassword(id Identity, password string) error {
	key := VaultKey{User: id.User, Host: id.Host, Port: id.Port}
	return a.vault.SaveSecret(VaultSecret{Type: SecretTypePassword, Key: key, Value: NewSecret(password)})
}

func (a *vaultCredentialAdapter) DeletePassword(id Identity) error {
	key := VaultKey{User: id.User, Host: id.Host, Port: id.Port}
	return a.vault.DeleteSecret(SecretTypePassword, key)
}

func (a *vaultCredentialAdapter) HasPassword(id Identity) (bool, error) {
	key := VaultKey{User: id.User, Host: id.Host, Port: id.Port}
	s, err := a.vault.GetSecret(SecretTypePassword, key)
	if err != nil {
		return false, err
	}
	return s != nil, nil
}

func (a *vaultCredentialAdapter) LookupKeyPassphrase(hash KeyHash) (Secret, error) {
	s, err := a.vault.GetSecret(SecretTypeKeyPassphrase, VaultKey{Hash: string(hash)})
	if err != nil {
		return Secret{}, err
	}
	if s == nil {
		return Secret{}, nil
	}
	return s.Value, nil
}

func (a *vaultCredentialAdapter) SaveKeyPassphrase(hash KeyHash, passphrase string) error {
	return a.vault.SaveSecret(VaultSecret{
		Type:  SecretTypeKeyPassphrase,
		Key:   VaultKey{Hash: string(hash)},
		Value: NewSecret(passphrase),
	})
}

func (a *vaultCredentialAdapter) DeleteKeyPassphrase(hash KeyHash) error {
	return a.vault.DeleteSecret(SecretTypeKeyPassphrase, VaultKey{Hash: string(hash)})
}
