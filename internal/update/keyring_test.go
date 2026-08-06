package update

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"
)

// The keyring is the whole of the update system's trust. Everything else —
// the transactional swap, the journal, the rollback — runs only on a payload
// this slice of keys agreed to.
//
// It shipped as a literal nil with a comment saying the release pipeline
// populated it via ldflags. Nothing did, and nothing could: a nil field in a
// struct literal is not a linker symbol. VerifyManifest rejects an empty
// keyring, so every production update check failed before it ever compared
// versions, and the comment was the only thing that said otherwise
// (nocx-nfu5.1).
//
// These tests exist so that can never be true again without something going
// red: the keyring is asserted to be non-empty, well-formed, and reachable
// from the composition root.

func TestReleaseKeyring_IsNotEmpty(t *testing.T) {
	keys, err := ReleaseKeyring()
	if err != nil {
		t.Fatalf("ReleaseKeyring(): %v", err)
	}
	if len(keys) == 0 {
		t.Fatal("the release keyring is empty; a build that ships this can verify no update at all, " +
			"and VerifyManifest will refuse every manifest before comparing versions")
	}
}

// Every entry must be a usable ed25519 public key. A truncated or mistyped
// base64 line is the likeliest way this breaks, and it must break here rather
// than on a user's machine at the moment they are being offered an update.
func TestReleaseKeyring_EveryKeyIsWellFormed(t *testing.T) {
	keys, err := ReleaseKeyring()
	if err != nil {
		t.Fatalf("ReleaseKeyring(): %v", err)
	}
	for i, k := range keys {
		if len(k) != ed25519.PublicKeySize {
			t.Errorf("key %d is %d bytes, want %d", i, len(k), ed25519.PublicKeySize)
		}
	}
}

// A rotation adds a key; it never silently replaces one. Two identical entries
// mean somebody pasted rather than rotated, and the keyring would then claim a
// breadth of trust it does not have.
func TestReleaseKeyring_HasNoDuplicates(t *testing.T) {
	keys, err := ReleaseKeyring()
	if err != nil {
		t.Fatalf("ReleaseKeyring(): %v", err)
	}
	seen := make(map[string]int, len(keys))
	for i, k := range keys {
		enc := base64.StdEncoding.EncodeToString(k)
		if first, dup := seen[enc]; dup {
			t.Errorf("key %d duplicates key %d; a rotation adds a key, it does not paste one twice", i, first)
		}
		seen[enc] = i
	}
}

// The paired assertion the vault epic bought at some cost: for every "returns
// an error when…" there is a "and on an ordinary build it succeeds". A manifest
// signed by a key in the keyring verifies through the exported entry point,
// which is what the updater actually calls.
func TestReleaseKeyring_VerifiesAManifestSignedByOneOfItsKeys(t *testing.T) {
	// A key the keyring does not know, plus the real keyring: signing with
	// the stranger must fail even though the keyring is otherwise valid.
	strangerPub, strangerPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate stranger key: %v", err)
	}
	body := []byte(`{"version":"9.9.9","released":"2026-01-01T00:00:00Z","notesUrl":"","artifacts":[]}`)
	strangerSig := base64.StdEncoding.EncodeToString(ed25519.Sign(strangerPriv, body))

	keyring, err := ReleaseKeyring()
	if err != nil {
		t.Fatalf("ReleaseKeyring(): %v", err)
	}
	if _, vErr := VerifyManifest(body, strangerSig, keyring); vErr == nil {
		t.Fatal("a manifest signed by a key outside the keyring verified; the keyring trusts everyone")
	}

	// And the positive half: the same body, signed by a key that IS in the
	// keyring, goes through. The keyring under test is the real one, so the
	// stranger is appended rather than substituted — this asserts that
	// membership is what decides, not position or length.
	widened := append(append([]ed25519.PublicKey{}, keyring...), strangerPub)
	m, err := VerifyManifest(body, strangerSig, widened)
	if err != nil {
		t.Fatalf("manifest signed by a key in the keyring did not verify: %v", err)
	}
	if m.Version != "9.9.9" {
		t.Errorf("verified manifest version = %q, want 9.9.9", m.Version)
	}
}
