package update

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
)

// releaseKeys is the compiled-in set of public keys a release manifest may be
// signed by, base64 of the raw 32-byte ed25519 public key — the same encoding
// cmd/manifest-sign -keygen prints.
//
// # Why a compiled-in constant and not ldflags
//
// The field this replaces read `Keyring: nil, // populated by release pipeline
// via ldflags`, and nothing populated it, because nothing could: a nil in a
// struct literal is not a linker symbol, and no -X flag existed either. The
// comment was load-bearing in the worst way — it described an arrangement that
// had never been built, and it read as if it had (nocx-nfu5.1).
//
// A constant cannot drift from its comment. It is in the source, it is in the
// diff when it changes, and the tests next door assert it is non-empty and
// well-formed on every run.
//
// # Rotation
//
// A rotation ADDS a line here and ships a release signed by the new key; the
// old line stays until every install that only knows it has upgraded past a
// release carrying both. The distribution design (§6) states the limit rather
// than engineering around it: a binary that only ever knew key A cannot
// authenticate a manifest signed solely by key B, and with a latest-only
// endpoint it can never be handed an intermediate release — so retiring a key
// strands clients older than the release that introduced its successor, and
// they reinstall by hand. Losing a private key with no successor already in a
// shipped keyring strands every install permanently, which is why the seed
// lives in a backup outside GitHub as well as in the RELEASE_SIGNING_KEY
// secret.
var releaseKeys = []string{
	// v0.1.0, generated 2026-08-06. Private seed: RELEASE_SIGNING_KEY.
	"YyYUXhiZ0O9vQKAgH7TANdh7HVtVTPtui41X1ziwOoc=",
}

// ReleaseKeyring decodes the compiled-in public keys.
//
// It returns an error rather than panicking so that a malformed entry cannot
// take the whole application down at startup — a broken keyring must cost the
// user their update check, never their terminal. The failure is not silent
// either way: an empty or unparseable keyring makes VerifyManifest refuse
// every manifest, which is the fail-closed direction, and the tests in this
// package assert the shipped entries decode.
func ReleaseKeyring() ([]ed25519.PublicKey, error) {
	keys := make([]ed25519.PublicKey, 0, len(releaseKeys))
	for i, enc := range releaseKeys {
		raw, err := base64.StdEncoding.DecodeString(enc)
		if err != nil {
			return nil, fmt.Errorf("release keyring: key %d is not valid base64: %w", i, err)
		}
		if len(raw) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("release keyring: key %d decodes to %d bytes, want %d",
				i, len(raw), ed25519.PublicKeySize)
		}
		keys = append(keys, ed25519.PublicKey(raw))
	}
	return keys, nil
}
