package contentkey

import (
	"crypto/hkdf"
	"crypto/sha256"
)

// saltLen is the length of the per-machine salt. 32 bytes of random material
// with a 32-byte output key gives the derivation full entropy.
const saltLen = 32

// deriveInfo is the HKDF info string (nocx-rtg0.14): it names the purpose,
// so the same ikm can never derive a key for a different label.
const deriveInfo = "nocx-contentdb-v1"

// hkdfKey runs HKDF-SHA256 with the given input key material and the
// contentdb info label, producing the 32-byte ContentDB key.
func hkdfKey(ikm []byte) ([]byte, error) {
	return hkdf.Key(sha256.New, ikm, nil, deriveInfo, saltLen)
}
