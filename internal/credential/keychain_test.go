package credential

import "testing"

// TestKeychainImplementsSecretStore verifies the Keychain type alias satisfies
// the SecretStore interface at compile time. The concrete test coverage lives
// in secretstore_test.go.
func TestKeychainImplementsSecretStore(t *testing.T) {
	var _ SecretStore = NewKeychain()
}
