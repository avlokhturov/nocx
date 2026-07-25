package credential

import "testing"

// newTestVault creates a fresh, unlocked vault for testing.
func newTestVault(t *testing.T) *Vault {
	t.Helper()
	v := NewVault()
	return v
}

// secretEquals reports whether the Secret's plaintext equals want. It is a
// test-only helper that deliberately reads the plaintext through Use — the
// single binding accessor — so tests can assert on round-tripped values
// without introducing a package-wide string accessor.
func secretEquals(t *testing.T, got Secret, want string) {
	t.Helper()
	var s string
	if err := got.Use(func(b []byte) error { s = string(b); return nil }); err != nil {
		t.Fatalf("secret.Use: %v", err)
	}
	if s != want {
		t.Errorf("secret plaintext = %q, want %q", s, want)
	}
}
