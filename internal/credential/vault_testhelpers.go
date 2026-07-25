package credential

import "testing"

// newTestVault creates a fresh, unlocked vault for testing.
func newTestVault(t *testing.T) *Vault {
	t.Helper()
	v := NewVault()
	return v
}
