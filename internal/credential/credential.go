// Package credential provides the Secret type, SecretStore capability,
// and the vault-backed secret store adapter.
package credential

// VaultSecret is a single secret entry in the vault. The Value is a Secret
// so it cannot be serialized by accident — see secret.go. The vault
// persists through a private DTO that materializes plaintext only inside
// the encryption callback (vault.Marshal).
type VaultSecret struct {
	ID    SecretID
	Value Secret
}

// CredentialStore is a type alias for SecretStore. Retained for
// compatibility with the composition root (internal/app/app.go) which is
// owned by the STORE-1 worker and wires credential.NewKeychain() as a
// CredentialStore.
//
// New code should reference SecretStore directly. CredentialStore exists
// only to avoid editing app.go in this wave.
type CredentialStore = SecretStore

// vaultSecretStore adapts the raw encrypted vault to the SecretStore
// interface. This is the single place SSH code touches credentials — it
// never sees the vault encryption or passphrase.
type vaultSecretStore struct {
	vault *Vault
}

// NewCredentialStore wraps a Vault behind the SecretStore interface.
func NewCredentialStore(v *Vault) SecretStore {
	return &vaultSecretStore{vault: v}
}

func (a *vaultSecretStore) Get(id SecretID) (Secret, error) {
	vs, err := a.vault.GetSecret(id)
	if err != nil {
		return Secret{}, err
	}
	if vs == nil {
		return Secret{}, nil // absent is not an error
	}
	return vs.Value, nil
}

func (a *vaultSecretStore) Set(id SecretID, value Secret) error {
	return a.vault.SaveSecret(VaultSecret{ID: id, Value: value})
}

func (a *vaultSecretStore) Delete(id SecretID) error {
	return a.vault.DeleteSecret(id)
}

func (a *vaultSecretStore) Exists(id SecretID) (bool, error) {
	vs, err := a.vault.GetSecret(id)
	if err != nil {
		return false, err
	}
	return vs != nil, nil
}
