package credential

// Keychain is the keychain-backed SecretStore. It is a type alias for
// KeychainSecretStore retained for compatibility with the composition root
// (internal/app/app.go) which calls credential.NewKeychain() and stores the
// result as credential.CredentialStore.
type Keychain = KeychainSecretStore

// NewKeychain creates a keychain-backed credential store. It returns a
// *Keychain (= *KeychainSecretStore) which satisfies SecretStore (and
// therefore CredentialStore).
func NewKeychain() *Keychain {
	return NewKeychainSecretStore()
}
