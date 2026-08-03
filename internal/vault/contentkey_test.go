package vault

import (
	"strings"
	"testing"
)

// ContentKeyID is deterministic, provider-bound, and uses the persisted
// reference grammar (sec:v1:<provider>:<32hex>).
func TestContentKeyIDDeterministicAndProviderBound(t *testing.T) {
	a1, err := ContentKeyID(ProviderSystem)
	if err != nil {
		t.Fatalf("ContentKeyID: %v", err)
	}
	a2, _ := ContentKeyID(ProviderSystem)
	if a1 != a2 {
		t.Fatalf("ContentKeyID not deterministic: %q vs %q", a1, a2)
	}
	b, _ := ContentKeyID(ProviderFile)
	if a1 == b {
		t.Fatal("provider not bound into the reference")
	}
	if !strings.HasPrefix(string(a1), "sec:v1:system:") || len(a1) != len("sec:v1:system:")+32 {
		t.Fatalf("reference %q does not match sec:v1:<provider>:<32hex>", a1)
	}
	if _, err := ContentKeyID(ProviderID("UPPER")); err == nil {
		t.Fatal("invalid provider tag accepted")
	}
}

// DefaultProvider mirrors the vault document's choice, "" when unset.
func TestDefaultProvider(t *testing.T) {
	v := &Vault{doc: Document{DefaultProvider: ProviderFile}}
	if got := v.DefaultProvider(); got != ProviderFile {
		t.Fatalf("DefaultProvider = %q, want file", got)
	}
	v2 := &Vault{}
	if got := v2.DefaultProvider(); got != "" {
		t.Fatalf("DefaultProvider on unset doc = %q, want empty", got)
	}
}
