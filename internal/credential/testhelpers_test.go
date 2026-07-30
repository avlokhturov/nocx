package credential

import "testing"

// secretEquals reports whether the Secret's plaintext equals want. It reads
// the plaintext through Use — the single binding accessor — deliberately, so
// tests can assert on round-tripped values without the package growing a
// string accessor that production code could then reach for.
//
// It used to live in vault_testhelpers.go alongside a newTestVault helper.
// That file went with the encrypted-file vault when the implementation moved
// to internal/vault/file; only this helper had callers left.
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
